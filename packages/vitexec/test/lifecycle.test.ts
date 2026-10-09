import { readFile, writeFile } from "node:fs/promises";
import type { Page } from "playwright";
import { afterEach, expect, it, vi } from "vitest";
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
    // Tests that deliberately time out close() retain the same rejected close promise.
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

it.each([false, true])("bounds stuck capture cleanup after execution (timeout: %s)", async timedOut => {
  const page = await app();
  const cdp = await page.context().newCDPSession(page);
  const send = cdp.send.bind(cdp);
  let stopping: () => void = () => {};
  const stopped = new Promise<void>(resolve => { stopping = resolve; });
  vi.spyOn(cdp, "send").mockImplementation((method, params) => {
    if (method !== "Profiler.stop") return send(method, params);
    stopping();
    return new Promise<never>(() => {});
  });
  vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(cdp);
  const execution = run(page, timedOut ? "console.log('started'); await new Promise(() => {});" : "console.log('done');", {
    cpuProfilePath: `${project?.root}/profile.json`, timeoutMs: 500,
    onLog: () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  });
  const failure = execution.catch(error => formatError(error));
  await stopped;
  await vi.advanceTimersByTimeAsync(CLEANUP_GRACE_MS);
  const error = await failure;
  expect(error).toContain("cleanup timed out");
  if (timedOut) expect(error).toContain("Vitexec timed out after 500ms");
  await expect(run(page, "")).rejects.toThrow("close and reopen");
});

it("lets successful capture cleanup use the remaining execution budget", async () => {
  const page = await app();
  const cdp = await page.context().newCDPSession(page);
  const send = cdp.send.bind(cdp);
  let stopping: () => void = () => {};
  const stopped = new Promise<void>(resolve => { stopping = resolve; });
  vi.spyOn(cdp, "send").mockImplementation((method, params) => {
    if (method !== "Profiler.stop") return send(method, params);
    stopping();
    return new Promise<void>(resolve => setTimeout(resolve, 90_000)).then(() => send(method, params));
  });
  vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(cdp);
  const dispose = page.context().request.delete.bind(page.context().request);
  let disposed: () => void = () => {};
  const disposal = new Promise<void>(resolve => { disposed = resolve; });
  vi.spyOn(page.context().request, "delete").mockImplementation(async (...args) => {
    const result = await dispose(...args);
    disposed();
    return result;
  });
  let settled = false;
  const execution = run(page, "console.log('done');", {
    cpuProfilePath: `${project?.root}/profile.json`, timeoutMs: 120_000,
    onLog: () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  });
  const outcome = execution.then(() => { settled = true; return "saved"; }, error => { settled = true; return formatError(error); });
  await stopped;
  await disposal;
  await vi.advanceTimersByTimeAsync(CLEANUP_GRACE_MS + 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await outcome).toBe("saved");
});

it("gives failed execution only the cleanup grace period", async () => {
  const page = await app();
  const cdp = await page.context().newCDPSession(page);
  const send = cdp.send.bind(cdp);
  let stopping: () => void = () => {};
  const stopped = new Promise<void>(resolve => { stopping = resolve; });
  vi.spyOn(cdp, "send").mockImplementation((method, params) => {
    if (method !== "Profiler.stop") return send(method, params);
    stopping();
    return new Promise<never>(() => {});
  });
  vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(cdp);
  const outcome = run(page, 'console.log("started"); throw new Error("script failed");', {
    cpuProfilePath: `${project?.root}/profile.json`, timeoutMs: 120_000,
    onLog: () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  }).catch(error => formatError(error));
  await stopped;
  await vi.advanceTimersByTimeAsync(CLEANUP_GRACE_MS);
  expect(await outcome).toContain("script failed");
  expect(await outcome).toContain(`cleanup timed out after ${CLEANUP_GRACE_MS}ms`);
});

it.each(["rejects", "stalls", "fails cleanup"] as const)("bounds late capture initialization that %s", async behavior => {
  const page = await app();
  const cdp = await page.context().newCDPSession(page);
  const send = cdp.send.bind(cdp);
  let starting: () => void = () => {};
  const started = new Promise<void>(resolve => { starting = resolve; });
  let rejectStart: (error: Error) => void = () => {};
  let releaseStart: () => void = () => {};
  const released = new Promise<void>(resolve => { releaseStart = resolve; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.spyOn(cdp, "send").mockImplementation((method, params) => {
    if (behavior === "fails cleanup" && method === "Page.stopScreenRecording") {
      return Promise.reject(new Error("late recorder cleanup failed"));
    }
    if (method !== "Page.startScreenRecording") return send(method, params);
    if (behavior === "fails cleanup") {
      return send(method, params).then(async result => {
        starting();
        await released;
        return result;
      });
    }
    starting();
    return new Promise<never>((_, reject) => { rejectStart = reject; });
  });
  vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(cdp);
  let settled = false;
  const outcome = run(page, "", { recordPath: `${project?.root}/recording.mp4`, timeoutMs: 5_000 })
    .then(() => { settled = true; return "saved"; }, error => { settled = true; return formatError(error); });
  await started;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(settled).toBe(false);
  if (behavior === "rejects") rejectStart(new Error("late recorder initialization failed"));
  else if (behavior === "fails cleanup") releaseStart();
  else await vi.advanceTimersByTimeAsync(CLEANUP_GRACE_MS);
  const error = await outcome;
  expect(error).toContain("Vitexec timed out after 5000ms");
  const expected = {
    rejects: "late recorder initialization failed",
    stalls: "cleanup timed out",
    "fails cleanup": "late recorder cleanup failed"
  }[behavior];
  expect(error).toContain(expected);
});

it("continues browser and server shutdown when context close stalls", async () => {
  const page = await app();
  const url = page.url();
  const browser = page.context().browser();
  const contextClose = vi.spyOn(page.context(), "close").mockImplementation(() => new Promise(() => {}));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const closing = page.close().catch(error => formatError(error));
  await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
  const error = await closing;
  vi.useRealTimers();
  expect(error).toContain("Browser context shutdown timed out");
  expect(contextClose).toHaveBeenCalledOnce();
  expect(browser?.isConnected()).toBe(false);
  await expect(fetch(url)).rejects.toThrow();
});

it.each(["Page.stopScreenRecording", "IO.read"] as const)("bounds recording finalization when %s stalls", async stalledMethod => {
  const page = await app();
  const cdp = await page.context().newCDPSession(page);
  const send = cdp.send.bind(cdp);
  let stopping: () => void = () => {};
  const stopped = new Promise<void>(resolve => { stopping = resolve; });
  vi.spyOn(cdp, "send").mockImplementation((method, params) => {
    if (method !== stalledMethod) return send(method, params);
    stopping();
    return new Promise<never>(() => {});
  });
  vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(cdp);
  const execution = run(page, "console.log('done');", {
    recordPath: `${project?.root}/recording.mp4`, timeoutMs: 5_000,
    onLog: () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  });
  const failure = execution.catch(error => formatError(error));
  await stopped;
  await vi.advanceTimersByTimeAsync(CLEANUP_GRACE_MS);
  expect(await failure).toContain("cleanup timed out");
});

it("retains an execution error when script disposal also fails", async () => {
  const page = await app();
  vi.spyOn(page.context().request, "delete").mockRejectedValue(new Error("registration cleanup broke"));
  const error = await run(page, 'throw new Error("script broke");').catch(error => formatError(error));
  expect(error).toContain("script broke");
  expect(error).toContain("registration cleanup broke");
});

it("disables file watching even with a project configuration that enables it", async () => {
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
