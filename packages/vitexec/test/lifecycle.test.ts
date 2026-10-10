import { readFile, writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
import { capture } from "../src/artifacts.js";
import { openPage } from "../src/page.js";
import { run } from "../src/run.js";
import { formatError } from "../src/errors.js";
import { CLEANUP_GRACE_MS, SHUTDOWN_TIMEOUT_MS } from "../src/timeout.js";
import { createTempViteProject, type TestProject } from "./helpers.js";

let page: Page | undefined;
let project: TestProject | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await page?.close().catch(error => {
    if (!formatError(error).includes("shutdown timed out")) throw error;
  });
  await project?.close();
  page = undefined;
  project = undefined;
});

async function app() {
  project = await createTempViteProject({ "index.html": "<main>ready</main>" });
  page = await openPage({ root: project.root, configFile: false, gpu: false });
  return page;
}

const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

it.each([
  ["Page.stopScreenRecording", "done", 5_000],
  ["IO.read", "done", 5_000],
  ["Profiler.stop", "timeout", 500],
  ["Profiler.stop", "throw", 120_000]
] as const)("bounds stalled %s after %s", async (method, outcome, timeoutMs) => {
  const page = await app();
  const cdp = await page.context().newCDPSession(page);
  const send = cdp.send.bind(cdp);
  const stopping = vi.fn();
  vi.spyOn(cdp, "send").mockImplementation((name, params) => {
    if (name !== method) return send(name, params);
    stopping();
    return new Promise<never>(() => {});
  });
  vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(cdp);
  const scripts = {
    done: "",
    timeout: "await new Promise(() => {});",
    throw: 'throw new Error("script failed");'
  };
  const result = run(page, `console.log("started"); ${scripts[outcome]}`, {
    ...(method === "Profiler.stop" ? { cpuProfilePath: `${project?.root}/profile.json` } : { recordPath: `${project?.root}/recording.mp4` }),
    timeoutMs, onLog: fakeTimers
  }).catch(formatError);
  await vi.waitFor(() => expect(stopping).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(CLEANUP_GRACE_MS);
  const error = await result;
  expect(error).toContain("cleanup timed out");
  if (outcome === "timeout") expect(error).toContain("Vitexec timed out after 500ms");
  if (outcome === "throw") expect(error).toContain("script failed");
  await expect(run(page, "")).rejects.toThrow("close and reopen");
});

it("allows valid 90-second cleanup within the remaining execution budget", async () => {
  const page = await app();
  const cdp = await page.context().newCDPSession(page);
  const send = cdp.send.bind(cdp);
  const stopping = vi.fn();
  vi.spyOn(cdp, "send").mockImplementation((method, params) => {
    if (method !== "Profiler.stop") return send(method, params);
    stopping();
    return new Promise<void>(resolve => setTimeout(resolve, 90_000)).then(() => send(method, params));
  });
  vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(cdp);
  let settled = false;
  const result = run(page, 'console.log("done");', {
    cpuProfilePath: `${project?.root}/profile.json`, timeoutMs: 120_000, onLog: fakeTimers
  }).then(() => { settled = true; });
  await vi.waitFor(() => expect(stopping).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(CLEANUP_GRACE_MS + 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  await result;
});

it.each(["rejects", "stalls", "fails cleanup"] as const)("retains late recorder initialization that %s", async behavior => {
  const page = await app();
  const cdp = await page.context().newCDPSession(page);
  const send = cdp.send.bind(cdp);
  const starting = vi.fn();
  let release: () => void = () => {};
  let rejectStart: (error: Error) => void = () => {};
  const delayed = new Promise<void>((resolve, reject) => { release = resolve; rejectStart = reject; });
  fakeTimers();
  vi.spyOn(cdp, "send").mockImplementation((method, params) => {
    if (behavior === "fails cleanup" && method === "Page.stopScreenRecording") {
      return Promise.reject(new Error("late cleanup failed"));
    }
    if (method !== "Page.startScreenRecording") return send(method, params);
    if (behavior === "fails cleanup") return send(method, params).then(async result => {
      starting();
      await delayed;
      return result;
    });
    starting();
    return delayed.then(() => { throw new Error("Unexpected recorder release"); });
  });
  vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(cdp);
  const result = run(page, "", { recordPath: `${project?.root}/recording.mp4`, timeoutMs: 5_000 }).catch(formatError);
  await vi.waitFor(() => expect(starting).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(5_000);
  if (behavior === "rejects") rejectStart(new Error("late initialization failed"));
  else if (behavior === "fails cleanup") release();
  else await vi.advanceTimersByTimeAsync(CLEANUP_GRACE_MS);
  const error = await result;
  expect(error).toContain("Vitexec timed out after 5000ms");
  expect(error).toContain({ rejects: "late initialization failed", stalls: "cleanup timed out", "fails cleanup": "late cleanup failed" }[behavior]);
});

it("rejects promptly when the renderer crashes during capture finalization", async () => {
  const page = await app();
  const cdp = await page.context().newCDPSession(page);
  const send = cdp.send.bind(cdp);
  vi.spyOn(cdp, "send").mockImplementation((method, params) => {
    if (method !== "Profiler.stop") return send(method, params);
    // Raw Page.crash can stay pending; the run must reject its stalled cleanup.
    void send("Page.crash").catch(() => {});
    return new Promise<never>(() => {});
  });
  vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(cdp);
  const error = await run(page, "", { cpuProfilePath: `${project?.root}/profile.json` }).catch(formatError);
  expect(error).toMatch(/crash/i);
}, 5_000);

it.each(["startup", "finalization"] as const)("retains capture %s and detach errors", async phase => {
  const page = await app();
  const cdp = await page.context().newCDPSession(page);
  vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(cdp);
  const options = { cpuProfilePath: `${project?.root}/profile.json` };
  const captures = phase === "finalization" ? await capture(page, options, () => {}) : undefined;
  vi.spyOn(cdp, "send").mockRejectedValue(new Error("Profiler failed"));
  vi.spyOn(cdp, "detach").mockRejectedValue(new Error("Detach failed"));
  const result = captures ? captures.finish(true) : capture(page, options, () => {});
  const error = await result.catch(formatError);
  expect(error).toContain("Profiler failed");
  expect(error).toContain("Detach failed");
});

it("rejects saving captures after the page closed", async () => {
  const page = await app();
  const captures = await capture(page, { cpuProfilePath: `${project?.root}/profile.json` }, () => {});
  await page.close();
  await expect(captures.finish(false)).resolves.toBeUndefined();
  await expect(captures.finish(true)).rejects.toThrow("Page closed");
});

it("continues browser and server shutdown after context close stalls", async () => {
  const page = await app();
  const url = page.url();
  const browser = page.context().browser();
  vi.spyOn(page.context(), "close").mockImplementation(() => new Promise(() => {}));
  fakeTimers();
  const closing = page.close().catch(formatError);
  await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
  expect(await closing).toContain("Browser context shutdown timed out");
  vi.useRealTimers();
  expect(browser?.isConnected()).toBe(false);
  await expect(fetch(url)).rejects.toThrow();
});

it("retains execution and script disposal errors", async () => {
  const page = await app();
  vi.spyOn(page.context().request, "delete").mockRejectedValue(new Error("disposal failed"));
  const error = await run(page, 'throw new Error("script failed");').catch(formatError);
  expect(error).toContain("script failed");
  expect(error).toContain("disposal failed");
});

it("disables watching even when project configuration enables it", async () => {
  project = await createTempViteProject({
    "index.html": '<script type="module" src="/main.js"></script>',
    "main.js": 'window.boots = (window.boots ?? 0) + 1;',
    "vite.config.js": 'export default { server: { hmr: true, watch: { usePolling: true, interval: 10 } } };'
  });
  page = await openPage({ root: project.root, gpu: false });
  const before = await page.evaluate(() => performance.timeOrigin);
  await writeFile(`${project.root}/main.js`, `${await readFile(`${project.root}/main.js`, "utf8")}\nconsole.log('changed');`);
  await new Promise(resolve => setTimeout(resolve, 500));
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
});
