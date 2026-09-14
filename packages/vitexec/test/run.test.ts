import { readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createBrowser, createServer as createAppServer, run } from "../src/cli.js";
import { stream, type AppRunOptions } from "../src/run.js";
import { vitexec } from "../src/index.js";
import { createTempViteProject, type TestProject } from "./helpers.js";

let browser: Browser;
let project: TestProject | undefined;
let server: ViteDevServer | undefined;

beforeAll(async () => { browser = await createBrowser({ browserArgs: ["--enable-automation"] }); });
afterAll(async () => { await browser.close(); });
afterEach(async () => {
  await Promise.all(browser.contexts().map(context => context.close()));
  await server?.close();
  await project?.close();
  server = undefined;
  project = undefined;
  vi.restoreAllMocks();
});

async function collect(target: Browser | Page, code: string, options: AppRunOptions = {}): Promise<string> {
  const output: string[] = [];
  if ("newContext" in target) await run(target, code, { ...options, onLog: line => output.push(line) });
  else await run(target, code, { ...options, onLog: line => output.push(line) });
  return output.join("\n");
}

async function app({ plugin = true, base = "/" } = {}): Promise<Page> {
  project = await createTempViteProject({
    "index.html": '<input id="value"><script type="module" src="/main.ts"></script>',
    "main.ts": 'import { store } from "./store.ts"; window.store = store; document.body.dataset.ready = "yes";',
    "store.ts": 'export const store = { count: 7 };'
  }, await realpath(tmpdir()));
  server = await createServer({
    root: project.root, configFile: false, logLevel: "silent", base,
    resolve: { alias: { "@store": `${project.root}/store.ts` } },
    plugins: plugin ? [vitexec()] : [],
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: null }
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error("Vite did not expose its URL.");
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.body.dataset.ready === "yes");
  return page;
}

describe("programmatic run", () => {
  it("creates a listening injection server and awaits successive runs without a log callback", async () => {
    project = await createTempViteProject({ "index.html": "<main>0</main>" });
    const app = await createAppServer({ root: project.root, configFile: false });
    try {
      const page = await browser.newPage();
      await page.goto(app.url);
      const code = 'document.querySelector("main").textContent = Number(document.querySelector("main").textContent) + 1;';
      await run(page, code);
      await run(page, code);
      expect(await page.locator("main").textContent()).toBe("2");
      expect(page.url()).toBe(app.url);
    } finally { await app.close(); }
  });

  it("propagates log callback errors and cleans up for the next run", async () => {
    const page = await app();
    await expect(run(page, 'console.log("started"); await new Promise(() => {});', {
      onLog: () => { throw new Error("log failed"); }
    })).rejects.toThrow("log failed");
    await run(page, 'document.querySelector("input").value = "next";');
    expect(await page.locator("input").inputValue()).toBe("next");
  });

  it("creates browsers with GPU and audio enabled by default", async () => {
    const cdp = await browser.newBrowserCDPSession();
    try {
      const { arguments: args } = await cdp.send("Browser.getBrowserCommandLine");
      expect(args).toContain("--enable-unsafe-webgpu");
      expect(args).not.toContain("--mute-audio");
    } finally { await cdp.detach(); }
    const plain = await createBrowser({ gpu: false, audio: false, browserArgs: ["--enable-automation"] });
    try {
      const session = await plain.newBrowserCDPSession();
      const { arguments: args } = await session.send("Browser.getBrowserCommandLine");
      expect(args).not.toContain("--enable-unsafe-webgpu");
      expect(args).toContain("--mute-audio");
      await session.detach();
    } finally { await plain.close(); }
  });

  it("starts a fresh app and closes only its context", async () => {
    project = await createTempViteProject({ "index.html": "<main>fresh</main>" });
    const existing = await browser.newPage();
    const output = await collect(browser, 'console.log(document.querySelector("main")?.textContent)', {
      root: project.root, configFile: false
    });
    expect(output).toContain("[log] fresh");
    expect(browser.isConnected()).toBe(true);
    expect(existing.isClosed()).toBe(false);
    expect(browser.contexts()).toHaveLength(1);
  });

  it("preserves the current document and module state across TypeScript injections", async () => {
    const page = await app({ base: "/nested/" });
    await page.locator("#value").fill("preserve me");
    const url = page.url();
    let navigations = 0;
    page.on("framenavigated", () => navigations++);
    const code = 'import { store } from "@store"; const amount: number = 1; store.count += amount; console.log(store === window.store, store.count);';
    expect(await collect(page, code, { moduleExtension: ".ts" })).toContain("[log] true 8");
    expect(await collect(page, code, { moduleExtension: ".ts" })).toContain("[log] true 9");
    expect(await page.locator("#value").inputValue()).toBe("preserve me");
    expect(page.url()).toBe(url);
    expect(navigations).toBe(0);
    expect(page.isClosed()).toBe(false);
  });

  it("supports vitexec input in an existing app", async () => {
    const page = await app();
    await page.locator("#value").focus();
    await collect(page, 'import { keyboard } from "vitexec"; await keyboard.press("a");');
    expect(await page.locator("#value").inputValue()).toBe("a");
  });

  it("fails clearly without the plugin and never navigates as a fallback", async () => {
    const page = await app({ plugin: false });
    const url = page.url();
    await expect(collect(page, 'console.log("unreachable")')).rejects.toThrow("Add vitexec()");
    expect(page.url()).toBe(url);
    expect(page.isClosed()).toBe(false);
  });

  it("reports script failures and allows the next run", async () => {
    const page = await app();
    expect(await collect(page, 'throw new Error("snippet failed")')).toContain("snippet failed");
    expect(await collect(page, 'console.log("next")')).toContain("[log] next");
  });

  it("times out without closing the page or changing its default timeout", async () => {
    const page = await app();
    page.setDefaultTimeout(50);
    const output = await collect(page, 'await new Promise(() => {});', { timeoutMs: 100 });
    expect(output).toContain("timeout after 100ms");
    expect(page.isClosed()).toBe(false);
    await expect(page.locator("#missing").click()).rejects.toThrow("Timeout 50ms");
    expect(await collect(page, 'console.log("after timeout")')).toContain("after timeout");
  });

  it("rejects overlapping page runs and releases its listeners on early exit", async () => {
    const page = await app();
    const off = vi.spyOn(page, "off");
    const observer = vi.fn();
    page.on("console", observer);
    const first = stream(page, 'console.log("started"); await new Promise(() => {});');
    expect((await first.next()).value).toContain("started");
    await expect(collect(page, 'console.log("overlap")')).rejects.toThrow("already running");
    await first.return(undefined);
    expect(off).toHaveBeenCalledWith("console", expect.any(Function));
    await page.evaluate(() => console.log("caller listener"));
    expect(observer).toHaveBeenCalled();
    expect(page.isClosed()).toBe(false);
    expect(await collect(page, 'console.log("after cancellation")')).toContain("after cancellation");
  });

  it("stops profiling on cancellation so the same page can be profiled again", async () => {
    const page = await app();
    if (!project) throw new Error("Missing test project.");
    const path = `${project.root}/trace.json`;
    const first = stream(page, 'console.log("started"); await new Promise(() => {});', {
      performanceTracePath: path
    });
    expect((await first.next()).value).toContain("started");
    await first.return(undefined);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await collect(page, 'console.log("profiled")', { performanceTracePath: path }))
      .toContain(`[performance-trace] ${path}`);
    expect(JSON.parse(await readFile(path, "utf8"))).toHaveProperty("traceEvents");
  });

  it("rejects app-only options for an existing page", async () => {
    const page = await app();
    const options = { root: "/unused", timeoutMs: 1000 };
    await expect(collect(page, "", options)).rejects.toThrow("root requires a Browser target");
  });

  it("waits for app navigation even if the snippet finishes first", async () => {
    project = await createTempViteProject({
      "index.html": '<img src="/slow.svg"><script>window.addEventListener("load", () => console.log("app loaded"));</script>',
      "vite.config.js": `export default { plugins: [{ name: "slow-image", configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== "/slow.svg") return next();
          setTimeout(() => {
            res.setHeader("content-type", "image/svg+xml");
            res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
          }, 250);
        });
      } }] };`
    });
    const output = await collect(browser, 'console.log("snippet done")', { root: project.root });
    expect(output).toContain("[log] snippet done");
    expect(output).toContain("[log] app loaded");
  });

  it("can cancel while navigation is waiting for an unfinished resource", async () => {
    project = await createTempViteProject({
      "index.html": '<img src="/pending.svg">',
      "vite.config.js": `export default { plugins: [{ name: "pending-image", configureServer(server) {
        server.middlewares.use((req, _res, next) => { if (req.url !== "/pending.svg") next(); });
      } }] };`
    });
    const execution = stream(browser, 'console.log("started")', { root: project.root, timeoutMs: 10000 });
    expect((await execution.next()).value).toContain("started");
    await execution.return(undefined);
    expect(browser.contexts()).toHaveLength(0);
    expect(browser.isConnected()).toBe(true);
  }, 3000);

  it("cleans up a fresh context on early exit", async () => {
    project = await createTempViteProject({ "index.html": "<main>fresh</main>" });
    for await (const line of stream(browser, 'console.log("started"); await new Promise(() => {});', {
      root: project.root, configFile: false
    })) {
      if (line.includes("started")) break;
    }
    expect(browser.isConnected()).toBe(true);
    expect(browser.contexts()).toHaveLength(0);
  });
});
