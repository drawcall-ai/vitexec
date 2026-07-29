import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { build, createServer, type Plugin, type ViteDevServer } from "vite";
import { vitexec } from "../src/index.js";
import { createTempViteProject, type TestProject } from "./helpers.js";

let project: TestProject | undefined;
let server: ViteDevServer | undefined;
let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  await server?.close();
  await project?.close();
  server = undefined;
  project = undefined;
});

async function startServer(root: string, plugins: Plugin[] = []): Promise<string> {
  server = await createServer({
    configFile: false,
    logLevel: "silent",
    plugins,
    root,
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false
    }
  });
  await server.listen();

  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("Vite did not expose a local URL.");
  return url;
}

function appFiles(scriptPath = "vitexec/smoke.ts"): Record<string, string> {
  return {
    "index.html": `
      <main>app</main>
      <script type="module" src="/src/main.ts"></script>
    `,
    "src/main.ts": `
      document.querySelector("main")?.setAttribute("data-app-ready", "yes");
    `,
    [scriptPath]: `
      const runs = Number(document.body.dataset.vitexecRuns ?? 0) + 1;
      document.body.dataset.vitexecRuns = String(runs);
    `
  };
}

describe("vitexec Vite plugin", () => {
  it("serves discovered pages once with duplicate plugin declarations", async () => {
    project = await createTempViteProject(appFiles());
    const url = await startServer(project.root, [
      vitexec(),
      vitexec(),
      vitexec()
    ]);
    const page = await browser.newPage();
    await page.goto(new URL("smoke.html", url).toString());
    await expect.poll(() => page.locator("body").getAttribute("data-vitexec-runs"))
      .toBe("1");
    await expect.poll(() => page.locator("main").getAttribute("data-app-ready"))
      .toBe("yes");
  });

  it("supports explicit page mappings without directory discovery", async () => {
    project = await createTempViteProject(appFiles("checks/custom.ts"));
    const url = await startServer(project.root, [
      vitexec({
        directory: false,
        pages: {
          "/custom.html": "/checks/custom.ts"
        }
      })
    ]);
    const page = await browser.newPage();
    await page.goto(new URL("custom.html", url).toString());
    await expect.poll(() => page.locator("body").getAttribute("data-vitexec-runs"))
      .toBe("1");
  });

  it("rejects conflicting mappings", async () => {
    project = await createTempViteProject({
      "index.html": "<main>app</main>",
      "checks/one.ts": "",
      "checks/two.ts": ""
    });

    await expect(createServer({
      configFile: false,
      logLevel: "silent",
      root: project.root,
      plugins: [
        vitexec({ directory: false, pages: { "/check.html": "/checks/one.ts" } }),
        vitexec({ directory: false, pages: { "/check.html": "/checks/two.ts" } })
      ]
    })).rejects.toThrow('Conflicting vitexec scripts for "/check.html".');
  });

  it("builds discovered pages alongside the normal app", async () => {
    project = await createTempViteProject({
      ...appFiles(),
      "checks/custom.ts": `
        document.body.dataset.customVitexec = "yes";
      `
    });
    await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        vitexec(),
        vitexec({
          directory: false,
          pages: {
            "/custom.html": "/checks/custom.ts"
          }
        }),
        vitexec()
      ],
      root: project.root
    });

    const index = await readFile(join(project.root, "dist/index.html"), "utf8");
    const smoke = await readFile(join(project.root, "dist/smoke.html"), "utf8");
    const custom = await readFile(join(project.root, "dist/custom.html"), "utf8");
    expect(index).not.toContain("vitexec-smoke");
    expect(smoke).toContain("/assets/vitexec-smoke-");
    expect(custom).toContain("/assets/vitexec-custom-");

    const url = await startServer(join(project.root, "dist"));
    const page = await browser.newPage();
    await page.goto(new URL("smoke.html", url).toString());
    await expect.poll(() => page.locator("body").getAttribute("data-vitexec-runs"))
      .toBe("1");
    await expect.poll(() => page.locator("main").getAttribute("data-app-ready"))
      .toBe("yes");
    await page.goto(new URL("custom.html", url).toString());
    await expect.poll(() => page.locator("body").getAttribute("data-custom-vitexec"))
      .toBe("yes");
  });
});
