import { spawn as spawnProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import type { TestProject } from "./helpers.js";
import { createTempViteProject } from "./helpers.js";
import {
  createBrowserArgs,
  createRunOptions,
  createRemoteBrowserHeaders,
  ensureChromiumInstalled,
  resolveVitexecCodeInputDetails,
  resolveVitexecCodeInput,
  runVitexec,
  VITEXEC_ENV,
  VITEXEC_REMOTE_GPU_BROWSER_ARGS,
  VITEXEC_TIMEOUT_MS
} from "../src/cli.js";

let currentProject: TestProject | undefined;
let currentTempDir: string | undefined;
let stopCurrentPlaywrightServer: (() => Promise<void>) | undefined;

afterEach(async () => {
  await stopCurrentPlaywrightServer?.();
  await currentProject?.close();
  if (currentTempDir) await rm(currentTempDir, { recursive: true, force: true });
  stopCurrentPlaywrightServer = undefined;
  currentProject = undefined;
  currentTempDir = undefined;
});

async function collectVitexec(
  code: string,
  options: Parameters<typeof runVitexec>[1] = {}
): Promise<string> {
  const logs: string[] = [];
  for await (const line of runVitexec(code, options)) {
    logs.push(line);
  }

  return logs.join("\n");
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

describe("vitexec CLI runner", () => {
  it("returns browser logs for injected code", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec("console.log('loaded')", {
      configFile: false,
      root: currentProject.root
    });

    expect(output).toContain("[log] loaded");
  });

  it("installs Chromium when the Playwright executable is missing", async () => {
    const logs: string[] = [];
    let installCount = 0;

    await ensureChromiumInstalled({
      executablePath: () => "/missing/chromium",
      fileExists: async () => false,
      install: async () => {
        installCount += 1;
      },
      log: (line) => logs.push(line)
    });

    expect(installCount).toBe(1);
    expect(logs).toEqual(["[playwright] installing Chromium browser..."]);
  });

  it("does not install Chromium when the Playwright executable exists", async () => {
    let installCount = 0;

    await ensureChromiumInstalled({
      executablePath: () => "/installed/chromium",
      fileExists: async () => true,
      install: async () => {
        installCount += 1;
      }
    });

    expect(installCount).toBe(0);
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

    const output = await collectVitexec(code, {
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

    const output = await collectVitexec(input.code, {
      configFile: false,
      moduleExtension: input.moduleExtension,
      root: currentProject.root
    });

    expect(output).toContain("[log] loaded from ts");
  });

  it("lets injected code write files relative to the Vite root", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
      `
        import { writeFile } from "vitexec/client";

        await writeFile("generated/data.json", { ok: true });
        await writeFile("generated/message.txt", "hello");
        await writeFile("generated/bytes.bin", new Uint8Array([0, 1, 2, 3]).subarray(1, 3));
        console.log("files written");
      `,
      { configFile: false, root: currentProject.root }
    );

    await expect(readJson(join(currentProject.root, "generated/data.json"))).resolves.toEqual({
      ok: true
    });
    await expect(readFile(join(currentProject.root, "generated/message.txt"), "utf8")).resolves.toBe(
      "hello"
    );
    await expect(readFile(join(currentProject.root, "generated/bytes.bin"))).resolves.toEqual(
      Buffer.from([1, 2])
    );
    expect(output).toContain("[write-file] generated/data.json");
    expect(output).toContain("[log] files written");
  });

  it("rejects vitexec/client writeFile paths outside the Vite root", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
      `
        import { writeFile } from "vitexec/client";

        await writeFile("../escape.txt", "nope");
      `,
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("vitexec writeFile path cannot escape the Vite root");
  });

  it("captures runtime errors from injected code", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
      "throw new Error('injected failure')",
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("injected failure");
  });

  it("captures non-Error values thrown from injected code", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
      `
        throw "plain string failure";
      `,
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("[error] plain string failure");
    expect(output).not.toContain("[error] timeout");
  });

  it("captures object values thrown from injected code", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
      `
        throw { kind: "object failure", code: 42 };
      `,
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain('[error] {"kind":"object failure","code":42}');
    expect(output).not.toContain("[error] timeout");
  });

  it("captures rejected promises from injected code", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
      `
        await Promise.reject(new TypeError("async injected rejection"));
      `,
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("async injected rejection");
    expect(output).not.toContain("[error] timeout");
  });

  it("reports malformed injected code without timing out", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
      `
        const =
      `,
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("[error] Unexpected token '='");
    expect(output).not.toContain("[error] timeout");
  });

  it("reports failed static imports from injected code without timing out", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
      `
        import "/missing-vitexec-module.js";
      `,
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("[http 500] GET");
    expect(output).toContain("/__vitexec/code/");
    expect(output).toContain("Failed to fetch dynamically imported module");
    expect(output).not.toContain("[error] timeout");
  });

  it("captures async page errors scheduled by injected code", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
      `
        setTimeout(() => {
          throw new Error("scheduled injected failure");
        }, 0);
        await new Promise((resolve) => setTimeout(resolve, 50));
      `,
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("[page error] scheduled injected failure");
    expect(output).not.toContain("[error] timeout");
  });

  it("stops waiting immediately when injected code throws and returns the error logs", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const startedAt = performance.now();
    const output = await collectVitexec(
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

    const output = await collectVitexec(
      "await new Promise((resolve) => setTimeout(resolve, 150)); console.log('async done')",
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("[log] async done");
  });

  it("keeps waiting when the page navigates while injected code is running", async () => {
    currentProject = await createTempViteProject({
      "index.html": `
        <script>
          if (!sessionStorage.vitexecReloaded) {
            sessionStorage.vitexecReloaded = "yes";
            setTimeout(() => location.reload(), 0);
          }
        </script>
        <main>ready</main>
      `
    });

    const output = await collectVitexec(
      `
        await new Promise((resolve) => setTimeout(resolve, 50));
        console.log("after navigation", sessionStorage.vitexecReloaded);
      `,
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("[log] after navigation yes");
  });

  it("reports external navigations and continues in the new page", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
      `
        if (!sessionStorage.vitexecReloadedDuringRun) {
          sessionStorage.vitexecReloadedDuringRun = "yes";
          console.log("before external reload");
          location.reload();
          await new Promise(() => {});
        }

        console.log("after external reload", document.querySelector("main")?.textContent);
      `,
      { configFile: false, root: currentProject.root }
    );

    expect(output).toContain("[log] before external reload");
    expect(output).toContain("[navigation] navigated");
    expect(output).toContain("[log] after external reload ready");
  });

  it("does not hot reload changed app files while injected code is running", async () => {
    currentProject = await createTempViteProject({
      "index.html": `
        <main>loading</main>
        <script type="module" src="/src/main.js"></script>
      `,
      "src/main.js": `
        import { message } from "./message.js";

        const main = document.querySelector("main");
        main.textContent = message;

        if (import.meta.hot) {
          import.meta.hot.accept("./message.js", (module) => {
            main.textContent = module.message;
            console.log("hmr update", module.message);
          });
        }
      `,
      "src/message.js": `export const message = "initial";`
    });

    const logs = runVitexec(
      `
        while (document.querySelector("main")?.textContent !== "initial") {
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        console.log("first", document.querySelector("main")?.textContent);
        await new Promise((resolve) => setTimeout(resolve, 500));
        console.log("last", document.querySelector("main")?.textContent);
      `,
      { configFile: false, root: currentProject.root }
    );

    const output: string[] = [];
    let updatedFile = false;
    for await (const line of logs) {
      output.push(line);
      if (!updatedFile && line === "[log] first initial") {
        updatedFile = true;
        await writeFile(
          join(currentProject.root, "src", "message.js"),
          `export const message = "changed";`,
          "utf8"
        );
      }
    }

    const text = output.join("\n");
    expect(updatedFile).toBe(true);
    expect(text).toContain("[log] first initial");
    expect(text).toContain("[log] last initial");
    expect(text).not.toContain("hmr update");
    expect(text).not.toContain("changed");
  });

  it("formats console values that JSON cannot represent", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec("console.log(undefined, null)", {
      configFile: false,
      root: currentProject.root
    });

    expect(output).toContain("[log] undefined null");
  });

  it("yields browser logs before injected code finishes", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const startedAt = performance.now();
    const logs = runVitexec(
      `
        console.log("first");
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        console.log("second");
      `,
      { configFile: false, root: currentProject.root, timeoutMs: 5_000 }
    );

    while (true) {
      const result = await logs.next();
      expect(result.done).toBe(false);
      if (result.value === "[log] first") break;
    }

    expect(performance.now() - startedAt).toBeLessThan(800);

    const remainingLogs: string[] = [];
    for await (const line of logs) {
      remainingLogs.push(line);
    }

    expect(remainingLogs).toContain("[log] second");
  });

  it("stops the browser run when the log stream is closed early", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const startedAt = performance.now();
    for await (const line of runVitexec(
      `
        console.log("first");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      `,
      { configFile: false, root: currentProject.root, timeoutMs: 10_000 }
    )) {
      expect(line).toBe("[log] first");
      break;
    }

    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  it("can run a richer imported TypeScript assertion against an example", async () => {
    const root = fileURLToPath(
      new URL("../../../examples/chrome-offline-game/", import.meta.url)
    );

    const output = await collectVitexec(
      `
        import { OfflineRunnerGame } from "/src/game.ts";

        const canvas = document.createElement("canvas");
        canvas.style.width = "640px";
        canvas.style.height = "360px";
        document.body.append(canvas);

        const snapshots = [];
        const game = new OfflineRunnerGame(canvas, (snapshot) => snapshots.push(snapshot));
        game.togglePause();

        console.log("paused", game.getSnapshot().isPaused && snapshots.at(-1)?.isPaused);
      `,
      { configFile: false, root }
    );

    expect(output).toContain("[log] paused true");
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

    const output = await collectVitexec(
      `
        import { message } from "@app/message.js";
        console.log(message);
      `,
      { root: currentProject.root }
    );

    expect(output).toContain("[log] configured alias");
  });

  it("can open projects served over HTTPS with a local certificate", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>secure</main>",
      "certs/localhost-key.pem": LOCALHOST_KEY,
      "certs/localhost-cert.pem": LOCALHOST_CERT,
      "vite.config.ts": `
        import { fileURLToPath } from "node:url";
        import { readFileSync } from "node:fs";
        import { defineConfig } from "vite";

        export default defineConfig({
          server: {
            https: {
              key: readFileSync(fileURLToPath(new URL("./certs/localhost-key.pem", import.meta.url))),
              cert: readFileSync(fileURLToPath(new URL("./certs/localhost-cert.pem", import.meta.url)))
            }
          }
        });
      `
    });

    const output = await collectVitexec(
      "console.log(document.querySelector('main')?.textContent)",
      { root: currentProject.root }
    );

    expect(output).toContain("[log] secure");
  });

  it("loads injected code when the Vite project uses a custom base", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>base</main>",
      "vite.config.ts": `
        import { defineConfig } from "vite";

        export default defineConfig({
          base: "/xr/examples/minecraft/"
        });
      `
    });

    const output = await collectVitexec(
      "console.log(location.pathname, document.querySelector('main')?.textContent)",
      { root: currentProject.root }
    );

    expect(output).toContain("[log] /xr/examples/minecraft/ base");
    expect(output).not.toContain("[http 404]");
  });

  it("serves from an explicit config file directory when no root is set", async () => {
    currentProject = await createTempViteProject({
      "examples/performance/index.html": "<main>performance</main>",
      "examples/performance/vite.config.ts": `
        export default {
          base: "/uikit/examples/performance/"
        };
      `
    });

    const output = await collectVitexec(
      "console.log(location.pathname, document.querySelector('main')?.textContent)",
      {
        configFile: join(currentProject.root, "examples", "performance", "vite.config.ts"),
        timeoutMs: 1_000
      }
    );

    expect(output).toContain("[log] /uikit/examples/performance/ performance");
    expect(output).not.toContain("[http 404]");
    expect(output).not.toContain("[error] timeout");
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

    const output = await collectVitexec(
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

    const output = await collectVitexec(
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

    const output = await collectVitexec(
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

    const output = await collectVitexec(
      "document.body.textContent = 'recorded'; await new Promise((resolve) => setTimeout(resolve, 50))",
      { configFile: false, root: currentProject.root, recordPath }
    );

    expect(output).toContain(`[recording] ${recordPath}`);
    expect((await stat(recordPath)).size).toBeGreaterThan(0);
  });

  it("can capture a CPU profile for JavaScript hotspot analysis", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-cpu-"));
    const cpuProfilePath = join(currentTempDir, "nested", "cpu.cpuprofile");

    const output = await collectVitexec(
      `
        function vitexecCpuHotspot() {
          const end = performance.now() + 250;
          let total = 0;
          while (performance.now() < end) total += Math.sqrt(total + 1);
          return total;
        }

        console.log("cpu result", vitexecCpuHotspot() > 0);
      `,
      { configFile: false, root: currentProject.root, cpuProfilePath }
    );

    const profile = readCpuProfile(await readJson(cpuProfilePath));
    expect(output).toContain(`[cpu-profile] ${cpuProfilePath}`);
    expect(profile.nodes.length).toBeGreaterThan(0);
    expect(profile.nodes.some((node) => node.callFrame.functionName === "vitexecCpuHotspot")).toBe(true);
  });

  it("can capture a HAR network trace for failed request analysis", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-network-"));
    const networkTracePath = join(currentTempDir, "nested", "network.har");

    const output = await collectVitexec(
      `
        const response = await fetch("/__vitexec/code/missing-network-trace");
        console.log("network status", response.status);
      `,
      { configFile: false, root: currentProject.root, networkTracePath }
    );

    const har = readHar(await readJson(networkTracePath));
    expect(output).toContain(`[network-trace] ${networkTracePath}`);
    expect(har.log.entries.some((entry) => {
      return entry.request.url.includes("/__vitexec/code/missing-network-trace") && entry.response.status === 404;
    })).toBe(true);
  });

  it("can capture a Chrome performance trace for long task analysis", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-performance-"));
    const performanceTracePath = join(currentTempDir, "nested", "performance.trace.json");

    const output = await collectVitexec(
      `
        const end = performance.now() + 120;
        while (performance.now() < end) {}
        console.log("blocked main thread");
      `,
      { configFile: false, root: currentProject.root, performanceTracePath }
    );

    const trace = readPerformanceTrace(await readJson(performanceTracePath));
    expect(output).toContain(`[performance-trace] ${performanceTracePath}`);
    expect(trace.traceEvents.length).toBeGreaterThan(0);
    expect(trace.traceEvents.some((event) => event.name === "RunTask" || event.name === "FunctionCall")).toBe(true);
  });

  it("can capture an agent-friendly heap summary for memory leak analysis", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-heap-"));
    const heapSnapshotPath = join(currentTempDir, "nested", "heap.json");

    const output = await collectVitexec(
      `
        class VitexecLeakyWidget {
          constructor(index) {
            this.index = index;
            this.payload = "x".repeat(10_000);
          }
        }

        globalThis.__vitexecLeakyWidgets = Array.from(
          { length: 250 },
          (_, index) => new VitexecLeakyWidget(index)
        );
        console.log("leaks", globalThis.__vitexecLeakyWidgets.length);
      `,
      { configFile: false, root: currentProject.root, heapSnapshotPath }
    );

    const heap = readHeapSnapshot(await readJson(heapSnapshotPath));
    expect(output).toContain(`[heap-snapshot] ${heapSnapshotPath}`);
    expect(heap.schemaVersion).toBe(1);
    expect(heap.nodes.some((node) => node.name === "VitexecLeakyWidget")).toBe(true);
    expect(heap.edges.some((edge) => edge.name === "payload")).toBe(true);
    expect(heap.summary.topConstructorsByCount.some((entry) => entry.name === "VitexecLeakyWidget")).toBe(true);
  });

  it("can launch with gpu-friendly new headless mode", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
      "console.log('gpu mode')",
      { configFile: false, root: currentProject.root, gpu: true }
    );

    expect(output).toContain("[log] gpu mode");
  });

  it("can connect to a remote Playwright browser server", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>remote</main>"
    });
    const server = await startPlaywrightRunServer();
    stopCurrentPlaywrightServer = server.stop;

    const output = await collectVitexec(
      "console.log('remote text', document.querySelector('main')?.textContent)",
      {
        browserWsEndpoint: server.endpoint,
        configFile: false,
        root: currentProject.root
      }
    );

    expect(output).toContain("[log] remote text remote");
  });

  it("runs in an adopted page and leaves it (and its browser) open", async () => {
    currentProject = await createTempViteProject({ "index.html": "<main>adopt</main>" });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto("about:blank");

      const output = await collectVitexec(
        "console.log('adopted', document.querySelector('main')?.textContent)",
        { configFile: false, root: currentProject.root, page }
      );

      expect(output).toContain("[log] adopted adopt");
      expect(page.isClosed()).toBe(false);
      expect(browser.isConnected()).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("reuses one adopted page across sequential runs, each writing its own root", async () => {
    currentProject = await createTempViteProject({ "index.html": "<main>reuse</main>" });
    const second = await createTempViteProject({ "index.html": "<main>reuse</main>" });
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto("about:blank");

      const first = await collectVitexec(
        "import { writeFile } from 'vitexec/client'; await writeFile('run-1.txt', 'one'); console.log('run-1')",
        { configFile: false, root: currentProject.root, page }
      );
      // A second run on the same page must not throw "function already registered",
      // and its writeFile must land in the second run's root — not the first's.
      const secondOut = await collectVitexec(
        "import { writeFile } from 'vitexec/client'; await writeFile('run-2.txt', 'two'); console.log('run-2')",
        { configFile: false, root: second.root, page }
      );

      expect(first).toContain("[log] run-1");
      expect(secondOut).toContain("[log] run-2");
      expect(await readFile(join(currentProject.root, "run-1.txt"), "utf8")).toBe("one");
      expect(await readFile(join(second.root, "run-2.txt"), "utf8")).toBe("two");
      expect(page.isClosed()).toBe(false);
    } finally {
      await browser.close();
      await second.close();
    }
  });

  it("adopts a context (fresh page inside it) and closes only that page", async () => {
    currentProject = await createTempViteProject({ "index.html": "<main>ctx</main>" });
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const preexisting = await context.newPage();

      const output = await collectVitexec(
        "console.log('ctx', document.querySelector('main')?.textContent)",
        { configFile: false, root: currentProject.root, context }
      );

      expect(output).toContain("[log] ctx ctx");
      expect(browser.isConnected()).toBe(true);
      expect(preexisting.isClosed()).toBe(false);
    } finally {
      await browser.close();
    }
  });

  it("adopts a browser (fresh context + page) and leaves the browser open", async () => {
    currentProject = await createTempViteProject({ "index.html": "<main>br</main>" });
    const browser = await chromium.launch();
    try {
      const output = await collectVitexec(
        "console.log('br', document.querySelector('main')?.textContent)",
        { configFile: false, root: currentProject.root, browser }
      );

      expect(output).toContain("[log] br br");
      expect(browser.isConnected()).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it("opens the launched browser at a custom --viewport", async () => {
    currentProject = await createTempViteProject({ "index.html": "<main>vp</main>" });

    const output = await collectVitexec(
      "console.log('viewport', `${window.innerWidth}x${window.innerHeight}`)",
      { configFile: false, root: currentProject.root, viewport: "390x844" }
    );

    expect(output).toContain("[log] viewport 390x844");
  });

  it("rejects a malformed --viewport instead of silently using the default", async () => {
    currentProject = await createTempViteProject({ "index.html": "<main>vp</main>" });

    await expect(
      collectVitexec("console.log('unreached')", {
        configFile: false,
        root: currentProject.root,
        viewport: "not-a-size"
      })
    ).rejects.toThrow(/invalid --viewport/);
  });

  it("sends generic GPU launch options to remote Playwright browser servers", () => {
    expect(createRemoteBrowserHeaders({ gpu: false })).toBeUndefined();

    const headers = createRemoteBrowserHeaders({ gpu: true });
    const launchOptions = JSON.parse(
      headers?.["x-playwright-launch-options"] ?? "null"
    );

    expect(launchOptions).toEqual({
      args: VITEXEC_REMOTE_GPU_BROWSER_ARGS
    });
    expect(launchOptions.args).not.toContain("--use-angle=vulkan");
    expect(launchOptions.args).not.toContain("--enable-features=Vulkan");
  });

  it("can add custom browser launch args locally and remotely", () => {
    const browserArgs = [
      "--enable-features=Vulkan",
      "--use-angle=vulkan",
      "--use-vulkan=native"
    ];

    expect(createBrowserArgs({ gpu: true, browserArgs })).toEqual([
      ...VITEXEC_REMOTE_GPU_BROWSER_ARGS,
      ...browserArgs
    ]);

    const headers = createRemoteBrowserHeaders({ gpu: true, browserArgs });
    const launchOptions = JSON.parse(
      headers?.["x-playwright-launch-options"] ?? "null"
    );

    expect(launchOptions).toEqual({
      args: [...VITEXEC_REMOTE_GPU_BROWSER_ARGS, ...browserArgs]
    });
  });

  it("can configure run options from environment variables", () => {
    expect(createRunOptions({}, {
      env: {
        [VITEXEC_ENV.browserArgs]: "[\"--use-angle=vulkan\",\"--use-vulkan=native\"]",
        [VITEXEC_ENV.browserExposeNetwork]: "*.internal,<loopback>",
        [VITEXEC_ENV.browserWsEndpoint]: "wss://browser.example.test/",
        [VITEXEC_ENV.config]: "vite.env.config.ts",
        [VITEXEC_ENV.cpuProfile]: "artifacts/cpu.cpuprofile",
        [VITEXEC_ENV.gpu]: "true",
        [VITEXEC_ENV.heapSnapshot]: "artifacts/heap.json",
        [VITEXEC_ENV.networkTrace]: "artifacts/network.har",
        [VITEXEC_ENV.path]: "/env-route",
        [VITEXEC_ENV.performanceTrace]: "artifacts/performance.trace.json",
        [VITEXEC_ENV.record]: "artifacts/run.webm",
        [VITEXEC_ENV.screenshot]: "artifacts/page.png",
        [VITEXEC_ENV.timeout]: "12"
      },
      moduleExtension: ".ts"
    })).toEqual({
      browserArgs: ["--use-angle=vulkan", "--use-vulkan=native"],
      browserExposeNetwork: "*.internal,<loopback>",
      browserWsEndpoint: "wss://browser.example.test/",
      configFile: "vite.env.config.ts",
      cpuProfilePath: "artifacts/cpu.cpuprofile",
      gpu: true,
      heapSnapshotPath: "artifacts/heap.json",
      moduleExtension: ".ts",
      networkTracePath: "artifacts/network.har",
      path: "/env-route",
      performanceTracePath: "artifacts/performance.trace.json",
      recordPath: "artifacts/run.webm",
      screenshotPath: "artifacts/page.png",
      timeoutMs: 12_000
    });
  });

  it("lets CLI options override environment variables", () => {
    expect(createRunOptions(
      {
        browserArg: ["--cli-browser-arg"],
        browserWsEndpoint: "wss://cli-browser.example.test/",
        gpu: false,
        path: "/cli-route",
        timeout: 3
      },
      {
        env: {
          [VITEXEC_ENV.browserWsEndpoint]: "wss://env-browser.example.test/",
          [VITEXEC_ENV.browserArgs]: "[\"--env-browser-arg\"]",
          [VITEXEC_ENV.gpu]: "true",
          [VITEXEC_ENV.path]: "/env-route",
          [VITEXEC_ENV.timeout]: "30"
        }
      }
    )).toEqual(expect.objectContaining({
      browserArgs: ["--cli-browser-arg"],
      browserWsEndpoint: "wss://cli-browser.example.test/",
      gpu: false,
      path: "/cli-route",
      timeoutMs: 3_000
    }));
  });

  it("validates boolean environment variables", () => {
    expect(createRunOptions({}, {
      env: { [VITEXEC_ENV.gpu]: "on" }
    }).gpu).toBe(true);
    expect(createRunOptions({}, {
      env: { [VITEXEC_ENV.gpu]: "off" }
    }).gpu).toBe(false);
    expect(() => createRunOptions({}, {
      env: { [VITEXEC_ENV.gpu]: "sometimes" }
    })).toThrow("VITEXEC_GPU must be one of");
  });

  it("validates browser args environment variables", () => {
    expect(() => createRunOptions({}, {
      env: { [VITEXEC_ENV.browserArgs]: "--use-angle=vulkan" }
    })).toThrow("VITEXEC_BROWSER_ARGS must be a JSON string array");

    expect(() => createRunOptions({}, {
      env: { [VITEXEC_ENV.browserArgs]: "[\"--ok\", 123]" }
    })).toThrow("VITEXEC_BROWSER_ARGS must be a JSON string array");
  });

  it("reports failed resource loads with URL and status", async () => {
    currentProject = await createTempViteProject({
      "index.html": "<main>ready</main>"
    });

    const output = await collectVitexec(
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

    const output = await collectVitexec(
      "console.log('too slow')",
      { configFile: false, root: currentProject.root, timeoutMs: 1 }
    );

    expect(output).toContain("[error] timeout after 1ms");
  });
});

async function startPlaywrightRunServer(): Promise<{
  endpoint: string;
  stop: () => Promise<void>;
}> {
  const port = await getAvailablePort();
  const child = spawnProcess(
    "pnpm",
    [
      "exec",
      "playwright",
      "run-server",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--path",
      "/",
      "--max-clients",
      "1"
    ],
    {
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  const output: string[] = [];

  const endpoint = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for Playwright server.\n${output.join("")}`));
    }, 10_000);
    const finish = (callback: () => void) => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      callback();
    };
    const onData = (chunk: Buffer) => {
      output.push(chunk.toString());
      const match = output.join("").match(/Listening on (ws:\/\/\S+)/);
      if (match) finish(() => resolve(match[1]));
    };
    const onExit = (code: number | null) => {
      finish(() => {
        reject(new Error(`Playwright server exited with ${code}.\n${output.join("")}`));
      });
    };
    const onError = (error: Error) => {
      finish(() => reject(error));
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", onError);
    child.on("exit", onExit);
  });

  return {
    endpoint,
    stop: () => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.killed) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      child.kill();
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 2_000).unref();
    })
  };
}

async function getAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

type CpuProfile = {
  nodes: Array<{ callFrame: { functionName: string } }>;
};

function readCpuProfile(value: unknown): CpuProfile {
  expect(value).toEqual(expect.objectContaining({ nodes: expect.any(Array) }));
  return value as CpuProfile;
}

type Har = {
  log: {
    entries: Array<{
      request: { url: string };
      response: { status: number };
    }>;
  };
};

function readHar(value: unknown): Har {
  expect(value).toEqual(expect.objectContaining({
    log: expect.objectContaining({ entries: expect.any(Array) })
  }));
  return value as Har;
}

type PerformanceTrace = {
  traceEvents: Array<{ name?: string }>;
};

function readPerformanceTrace(value: unknown): PerformanceTrace {
  expect(value).toEqual(expect.objectContaining({ traceEvents: expect.any(Array) }));
  return value as PerformanceTrace;
}

type HeapSnapshot = {
  schemaVersion: 1;
  nodes: Array<{ name: string }>;
  edges: Array<{ name: string }>;
  summary: {
    topConstructorsByCount: Array<{ name: string }>;
  };
};

function readHeapSnapshot(value: unknown): HeapSnapshot {
  expect(value).toEqual(expect.objectContaining({
    schemaVersion: 1,
    nodes: expect.any(Array),
    edges: expect.any(Array),
    summary: expect.objectContaining({
      topConstructorsByCount: expect.any(Array)
    })
  }));
  return value as HeapSnapshot;
}

const LOCALHOST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCwhlLdX3a7cqgF
5Yv6CUvzna2zQrVkBXqRScdfDKg1os4MqTQGkK96lxL+sALPa/5lRvPu7AYCJUSg
54T2ApZg+9LhkPqgjLq2Wr0Xq20yMrpIKHzdlAOnt0BUpzHERD21cVNwYJ2rRkZM
dE6oPUE0nRCTuW5CNM2q1Tn3LAhmNypzhf4YdoI8Uck4u31Tem+EP9tjSD9R6Qm3
vgURjO318iGVuTGyCCt6RdoQdcFXtDPXq5+1UAx1sTbOYYUaXh9WexrrpcRQN2xn
1/0CB4FlccfXnNvHS3ZKEBqujNeYduqLqUbRwlSLjZdgt4HGyvJgjGkHjJ2hRbYZ
6dJpVUgPAgMBAAECggEACPzM6HyX2c3p6Y4ObgVlCp6noPpBVwERhIqDJw06iFZX
D+D2Md3SFdPuD9E4bvbIzPh5qtuDmbBBEPosN+fZtTK3wd28FBGJw2q5Y11mvkHS
JzCx3QillXBhddUGgLFCxCqrp2EGlgs0+dkzqgWDCxqO+nPN9uzcikPxDdzhkF+G
Ly+ZIjWN8U6zSH7uyCxKMTWhVwqZbGCclEiyH+lWa2dUk72LpkMxXCMgQv0yUeFH
96cYDeRFsBuQpcY5zYV4vDyzV14T7rW5r67wNuwEaee+xP37VqKD1GFTL5lgHJF8
tpSCUVi0PjDw28xcUROubYK1/sb/rP+FXO5UzwkwZQKBgQDkB7QS8gIy3C9WEwzj
77VEkhQRoOx0NPbgpgsQWvexiN7l+L7D4GVLQxT7pPUaLK3FfzvOfNY5Dwl4153l
0ze/+Xn1/hqUjL4/MUHNs8/a2qTfUVdoeY6wkrTf/vXeEucHB6QZTU7fNqa0iNtY
znoLPK0qmsdalCXrP29TSy78cwKBgQDGLVEYSCNOOPYWyNCWR1Sl8s1+NGf9m0DU
UhYIRxIHYCh7aR8u2WA97ogvrCglxCrSXtWHzqn60vIsMigdEfxuyirxdZLg3fS2
FXEUmq2762KvokxUfI/VQICLj5voN3ohFY6+cYu/K/yH2pemuN35FSXYPZhzi0he
H//SLN4a9QKBgE+RMJB7ybCdjBboxtKyTfoDTuVn1Zom8Q4qYinu1AcqzzxHs6j9
n9rHKYc1ZCEh/fCwGNpQTR/T02ZLNll/fjCKiLgBVp0HD0tVkLSKTbj8GhOienGG
GPgb+OlAOeKnjd2yGNyLUT4p/7l3F7LBOWy6W2JGZ9F/aEvR8rKJxXdpAoGBAIaj
kR3rHLlvL5oJMtV2fscD76KXnjMJgID/h+J1zoTeSoKVx86/doh8/19MGjaWUPV9
4pqSyJ8VI9zs8p3Vc2gdyBEl7PUDNtdiN+JkuDYc1H44yJz5x4p9eRfYKHcbAclq
aQFwCR6HltkBpNhrbrtkJ8MDDgkqDq+ME/TJ8NflAoGALTZV2s9mx7rQoOhU/JqB
JcAycHPhcDXSIc0YSMFAvtzCs4hC8j4sORacmdPLyEf1hTJlsk3HItAt2VXh57I2
pOTYGWdB02kwradfEeHnRE2tvoNMCRqIGOj7IaTY7WbkqSLFjQZzPD8fo1wlr80M
EzmM9UCtwZFemEKMGjGIZ3M=
-----END PRIVATE KEY-----
`;

const LOCALHOST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJTCCAg2gAwIBAgIUEUXtZCHbyIvwAFBmiCsP8jtYVZYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDQzMDAyMTI0MloXDTM2MDQy
NzAyMTI0MlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAsIZS3V92u3KoBeWL+glL852ts0K1ZAV6kUnHXwyoNaLO
DKk0BpCvepcS/rACz2v+ZUbz7uwGAiVEoOeE9gKWYPvS4ZD6oIy6tlq9F6ttMjK6
SCh83ZQDp7dAVKcxxEQ9tXFTcGCdq0ZGTHROqD1BNJ0Qk7luQjTNqtU59ywIZjcq
c4X+GHaCPFHJOLt9U3pvhD/bY0g/UekJt74FEYzt9fIhlbkxsggrekXaEHXBV7Qz
16uftVAMdbE2zmGFGl4fVnsa66XEUDdsZ9f9AgeBZXHH15zbx0t2ShAarozXmHbq
i6lG0cJUi42XYLeBxsryYIxpB4ydoUW2GenSaVVIDwIDAQABo28wbTAdBgNVHQ4E
FgQUC7VnONTsrcbGFoKtUY5AXlByfz0wHwYDVR0jBBgwFoAUC7VnONTsrcbGFoKt
UY5AXlByfz0wDwYDVR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SH
BH8AAAEwDQYJKoZIhvcNAQELBQADggEBAACWGeLNgSg9gTIEcMgrNEXaIqzuaSXQ
bQVT4Fsvqj/i7WG7fN/yNEzUsjb3EPPSoX7VLuNdwc/rV7L124ScxWV9iJN5/ct4
fnzv9yY4EoFM4S7ggxYFrqptY022YG6L15MUXxOGyHCWp9IahY2HUpCy4rAe9tQn
CmJW8Z3gVpW1pUKofN7hdFmtHtyMQw4+HfYFhA+tzKLHXIZp/p/qwVN7BSrmOIfB
HzkgeFWJXjN/Ob3qPjeKzoe3AbTC7qvKk0u7V7a2AEdsT6sZdu46Ukjnk8tO+gP3
dgvPmRq+ycWNbvncU5hNWSODF/1ufPr619lK8bYx0+bDQWnDynEr7Jg=
-----END CERTIFICATE-----
`;
