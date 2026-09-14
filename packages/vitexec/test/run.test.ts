import { readFile } from "node:fs/promises";
import type { Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { openBrowser, openPage, run } from "../src/cli.js";
import { createTempViteProject, type TestProject } from "./helpers.js";

let project: TestProject | undefined;
let page: Page | undefined;
afterEach(async () => { await page?.close(); await project?.close(); });

async function app(onLog: (line: string) => void = () => {}) {
  project = await createTempViteProject({
    "index.html": '<input><button>Click</button><script type="module" src="/main.ts"></script>',
    "main.ts": 'console.log("page ready"); document.querySelector("button").onclick = () => console.log("clicked");',
    "shared.ts": 'export async function log(value) { await new Promise(r => setTimeout(r, 10)); console.log(value); }'
  });
  page = await openPage({ root: project.root, configFile: false, gpu: false, onLog });
  return page;
}

async function collect(page: Page, code: string) {
  const output: string[] = [];
  await run(page, code, { onLog: line => output.push(line) });
  return output;
}

describe("page execution", () => {
  it("opens without code and closes all owned resources, including its server", async () => {
    const output: string[] = [];
    const page = await app(line => output.push(line));
    const url = page.url();
    const browser = page.context().browser();
    expect(output).toContain("[log] page ready");
    await page.close();
    expect(page.isClosed()).toBe(true);
    expect(browser?.isConnected()).toBe(false);
    await expect(fetch(url)).rejects.toThrow();
    await page.close();
  });

  it("preserves state and never navigates between runs", async () => {
    const page = await app();
    const url = page.url();
    await run(page, 'document.querySelector("input").value = "kept";');
    expect(await collect(page, 'console.log(document.querySelector("input").value)')).toEqual(["[log] kept"]);
    expect(page.url()).toBe(url);
  });

  it("routes concurrent direct and shared async logs without duplicates", async () => {
    const output: string[] = [];
    const page = await app(line => output.push(line));
    const [a, b] = await Promise.all([
      collect(page, 'import {log} from "/shared.ts"; console.log("a"); await log("async a");'),
      collect(page, 'import {log} from "/shared.ts"; console.log("b"); await log("async b");')
    ]);
    expect(a).toEqual(["[log] a", "[log] async a"]);
    expect(b).toEqual(["[log] b", "[log] async b"]);
    expect(output).toEqual(["[log] page ready"]);
  });

  it("reports thrown code and log callback failures", async () => {
    const page = await app();
    await expect(run(page, 'throw new Error("broken")')).rejects.toThrow("broken");
    await expect(run(page, 'console.log("start"); await new Promise(() => {});', {
      onLog: () => { throw new Error("callback failed"); }
    })).rejects.toThrow("callback failed");
    expect(await collect(page, 'console.log("next")')).toEqual(["[log] next"]);
  });

  it("fails a timeout and refuses to reuse uncertain page state", async () => {
    const page = await app();
    await expect(run(page, 'await new Promise(() => {});', { timeoutMs: 100 })).rejects.toThrow("timed out");
    expect(page.isClosed()).toBe(false);
    await expect(run(page, "")).rejects.toThrow("close and reopen");
  });

  it("rejects active execution when its page closes", async () => {
    const page = await app();
    let started: () => void = () => {};
    const ready = new Promise<void>(resolve => { started = resolve; });
    const execution = run(page, 'console.log("started"); await new Promise(() => {});', { onLog: started });
    const rejected = expect(execution).rejects.toThrow();
    await ready;
    await page.close();
    await rejected;
  });

  it("lets an observer finish while a driver holds a key", async () => {
    const page = await app();
    await page.locator("input").focus();
    await page.evaluate(() => document.addEventListener("keydown", event => {
      document.body.dataset.shift = String(event.shiftKey);
    }));
    let started: () => void = () => {};
    const ready = new Promise<void>(resolve => { started = resolve; });
    const driver = run(page, 'import { keyboard } from "vitexec"; await keyboard.down("Shift"); console.log("held"); await new Promise(r => window.resume = r); await keyboard.press("a");', { onLog: started });
    await ready;
    await run(page, 'console.log("observer");');
    await run(page, 'window.resume();');
    await driver;
    expect(await page.locator("body").getAttribute("data-shift")).toBe("true");
  });

  it("writes a screenshot after code completes", async () => {
    const page = await app();
    const path = `${project?.root}/shot.png`;
    await run(page, "", { screenshotPath: path });
    expect((await readFile(path)).length).toBeGreaterThan(100);
  });
  it("rejects a competing driver and overlapping profiles without interrupting the owner", async () => {
    const page = await app();
    let started: () => void = () => {};
    const ready = new Promise<void>(resolve => { started = resolve; });
    const driver = run(page, 'import { keyboard } from "vitexec"; await keyboard.down("Shift"); console.log("held"); await new Promise(r => window.resume = r);', {
      onLog: started, cpuProfilePath: `${project?.root}/profile.json`
    });
    await ready;
    await expect(run(page, 'import { keyboard } from "vitexec"; await keyboard.press("b");')).rejects.toThrow("owns this page");
    await expect(run(page, '', { cpuProfilePath: `${project?.root}/other.json` })).rejects.toThrow("recording or profiling");
    await run(page, 'window.resume();');
    await driver;
    await run(page, 'import { keyboard } from "vitexec"; await keyboard.press("b");');
  });

  it("fails without the plugin without closing or navigating a borrowed page", async () => {
    const browser = await openBrowser({ gpu: false });
    try {
      const borrowed = await browser.newPage();
      await expect(run(borrowed, '')).rejects.toThrow("Add vitexec()");
      expect(borrowed.url()).toBe("about:blank");
      expect(borrowed.isClosed()).toBe(false);
    } finally { await browser.close(); }
  });

  it("opens configured base paths and viewport sizes", async () => {
    project = await createTempViteProject({
      "index.html": '<main>nested</main>',
      "vite.config.js": 'export default { base: "/nested/" };'
    });
    page = await openPage({ root: project.root, viewport: "390x844", gpu: false });
    expect(page.url()).toContain("/nested/");
    expect(await collect(page, 'console.log(innerWidth, innerHeight)')).toEqual(["[log] 390 844"]);
  });

});
