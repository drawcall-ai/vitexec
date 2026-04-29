import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { TestProject } from "./helpers.js";
import { createTempViteProject } from "./helpers.js";
import {
  resolveVitexecCodeInputDetails,
  resolveVitexecCodeInput,
  runVitexec,
  VITEXEC_TIMEOUT_MS
} from "../src/cli.js";

let currentProject: TestProject | undefined;
let currentTempDir: string | undefined;

afterEach(async () => {
  await currentProject?.close();
  if (currentTempDir) await rm(currentTempDir, { recursive: true, force: true });
  currentProject = undefined;
  currentTempDir = undefined;
});

describe("vitexec CLI runner", () => {
  it("returns browser logs for injected code", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec("console.log('loaded')", {
      configFile: false,
      root: currentProject.root
    });

    expect(output).toContain("[log] loaded");
  });

  it("resolves a single file path to snippet code", async () => {
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-code-"));
    const codePath = join(currentTempDir, "inspect.js");
    await writeFile(codePath, "console.log('from file')", "utf8");

    await expect(resolveVitexecCodeInput([codePath])).resolves.toBe(
      "console.log('from file')"
    );
  });

  it("preserves TypeScript snippet extensions", async () => {
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-code-"));
    const codePath = join(currentTempDir, "inspect.ts");
    await writeFile(codePath, "const message: string = 'from ts'; console.log(message)", "utf8");

    await expect(resolveVitexecCodeInputDetails([codePath])).resolves.toEqual({
      code: "const message: string = 'from ts'; console.log(message)",
      moduleExtension: ".ts"
    });
  });

  it("keeps inline snippets as code when the input is not a file", async () => {
    await expect(
      resolveVitexecCodeInput(["console.log('inline')"])
    ).resolves.toBe("console.log('inline')");
    await expect(
      resolveVitexecCodeInput(["console.log", "('split')"])
    ).resolves.toBe("console.log ('split')");
  });

  it("keeps long inline snippets as code instead of treating them as paths", async () => {
    const code = `console.log(${JSON.stringify("x".repeat(1_000))})`;

    await expect(resolveVitexecCodeInput([code])).resolves.toBe(code);
  });

  it("can run injected code loaded from a file", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>",
      "inspect.js": "console.log('loaded from file')"
    });
    const code = await resolveVitexecCodeInput(
      ["inspect.js"],
      currentProject.root
    );

    const output = await runVitexec(code, {
      configFile: false,
      root: currentProject.root
    });

    expect(output).toContain("[log] loaded from file");
  });

  it("can run TypeScript code loaded from a file", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>",
      "inspect.ts": "const message: string = 'loaded from ts'; console.log(message)"
    });
    const input = await resolveVitexecCodeInputDetails(
      ["inspect.ts"],
      currentProject.root
    );

    const output = await runVitexec(input.code, {
      configFile: false,
      moduleExtension: input.moduleExtension,
      root: currentProject.root
    });

    expect(output).toContain("[log] loaded from ts");
  });

  it("captures runtime errors from injected code", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      "throw new Error('injected failure')",
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("injected failure");
  });

  it("stops waiting immediately when injected code throws and returns the error logs", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const startedAt = performance.now();
    const output = await runVitexec(
      `
        throw new Error("stop-on-error");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      `,
      { configFile: false, root: currentProject.root, timeoutMs: 10_000 }
    );
    const durationMs = performance.now() - startedAt;

    expect(output).toContain("stop-on-error");
    expect(output).not.toContain("[error] timeout");
    expect(durationMs).toBeLessThan(3_000);
  });

  it("waits for async injected code to finish", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      "await new Promise((resolve) => setTimeout(resolve, 150)); console.log('async done')",
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("[log] async done");
  });

  it("can run a richer imported Three.js assertion against the example", async () => {
    const root = fileURLToPath(
      new URL("../../../examples/basic-three/", import.meta.url)
    );

    const output = await runVitexec(
      `
        import { camera, cube, Vector3 } from "/src/scene-state.ts";
        const position = cube.getWorldPosition(new Vector3()).applyMatrix4(camera.matrixWorldInverse);
        console.log("front-left", position.z < 0 && position.x < 0);
      `,
      { configFile: false, root }
    );

    expect(output).toContain("[log] front-left true");
  });

  it("loads the project Vite config by default", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>",
      "src/message.js": "export const message = 'configured alias';",
      "vite.config.ts": `
        import { fileURLToPath } from "node:url";
        import { defineConfig } from "vite";

        export default defineConfig({
          resolve: {
            alias: {
              "@app": fileURLToPath(new URL("./src", import.meta.url))
            }
          }
        });
      `
    });

    const output = await runVitexec(
      `
        import { message } from "@app/message.js";
        console.log(message);
      `,
      { root: currentProject.root }
    );

    expect(output).toContain("[log] configured alias");
  });

  it("can load an explicit Vite config file", async () => {
    currentProject = await createTempViteProject({
      "custom.html": "<main>custom</main>",
      "src/message.js": "export const message = 'custom config';",
      "nested/vite.custom.ts": `
        import { fileURLToPath } from "node:url";
        import { defineConfig } from "vite";

        export default defineConfig({
          root: fileURLToPath(new URL("../", import.meta.url)),
          resolve: {
            alias: {
              "#src": fileURLToPath(new URL("../src", import.meta.url))
            }
          }
        });
      `
    });

    const output = await runVitexec(
      `
        import { message } from "#src/message.js";
        console.log(message);
      `,
      {
        configFile: join(currentProject.root, "nested", "vite.custom.ts"),
        path: "/custom.html"
      }
    );

    expect(output).toContain("[log] custom config");
  });

  it("opens the requested page path", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>home</main>",
      "cart/index.html": "<main id=\"route\">cart</main>"
    });

    const output = await runVitexec(
      "console.log(document.querySelector('#route')?.textContent)",
      { configFile: false, path: "cart/", root: currentProject.root }
    );

    expect(output).toContain("[log] cart");
  });

  it("can write a screenshot after injected code runs", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-shot-"));
    const screenshotPath = join(currentTempDir, "nested", "page.png");

    const output = await runVitexec(
      "document.body.style.background = 'rgb(255, 0, 0)'",
      { configFile: false, root: currentProject.root, screenshotPath }
    );

    expect(output).toContain(`[screenshot] ${screenshotPath}`);
    expect((await stat(screenshotPath)).size).toBeGreaterThan(0);
  });

  it("can record a browser video after injected code runs", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-record-"));
    const recordPath = join(currentTempDir, "nested", "page.webm");

    const output = await runVitexec(
      "document.body.textContent = 'recorded'; await new Promise((resolve) => setTimeout(resolve, 50))",
      { configFile: false, root: currentProject.root, recordPath }
    );

    expect(output).toContain(`[recording] ${recordPath}`);
    expect((await stat(recordPath)).size).toBeGreaterThan(0);
  });

  it("can launch with gpu-friendly new headless mode", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      "console.log('gpu mode')",
      { configFile: false, root: currentProject.root, gpu: true }
    );

    expect(output).toContain("[log] gpu mode");
  });

  it("reports failed resource loads with URL and status", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      "await fetch('/__vitexec/code/missing'); console.log('ready')",
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("[http 404] GET");
    expect(output).toContain("/__vitexec/code/missing");
    expect(output).not.toContain("Failed to load resource");
  });

  it("uses a 10 minute timeout and logs timeout errors", async () => {
    expect(VITEXEC_TIMEOUT_MS).toBe(10 * 60 * 1000);

    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      "console.log('too slow')",
      { configFile: false, root: currentProject.root, timeoutMs: 1 }
    );

    expect(output).toContain("[error] timeout after 1ms");
  });
});
