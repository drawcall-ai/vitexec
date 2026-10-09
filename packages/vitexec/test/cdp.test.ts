import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, test, vi } from "vitest";
import { capture } from "../src/artifacts.js";
import { openCdp } from "../src/cdp.js";

function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("CDP did not settle after renderer crash.")), 2_000);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

test("saving captures rejects when the page closed before finalization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vitexec-closed-capture-"));
  const path = join(directory, "profile.cpuprofile");
  const browser = await chromium.launch({ channel: "chromium", args: ["--disable-gpu"] });
  try {
    const page = await browser.newPage();
    const captures = await capture(page, { cpuProfilePath: path }, () => {});
    await page.close();
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(captures.finish(false)).resolves.toBeUndefined();
    await expect(captures.finish(true)).rejects.toThrow("Page closed");
  } finally {
    await browser.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pending CDP commands and event waits reject after a renderer crash", async () => {
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage();
    const cdp = await openCdp(page);
    const command = cdp.send("Runtime.evaluate", {
      expression: "globalThis.started = true; new Promise(() => {})",
      awaitPromise: true
    });
    const event = cdp.wait(new Promise<void>(() => {}));
    const commandCheck = expect(deadline(command)).rejects.toThrow("Page crashed");
    const eventCheck = expect(deadline(event)).rejects.toThrow("Page crashed");
    await page.waitForFunction("globalThis.started === true");
    await expect(deadline(cdp.send("Page.crash"))).rejects.toThrow("Page crashed");
    await Promise.all([commandCheck, eventCheck]);
    expect(browser.isConnected()).toBe(true);
    expect(page.isClosed()).toBe(false);
    await expect(deadline(cdp.detach())).rejects.toThrow("Page crashed");
  } finally {
    await browser.close();
  }
});

test("successful CDP detach leaves the page usable", async () => {
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    const create = vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(session);
    const cdp = await openCdp(page);
    create.mockRestore();
    await expect(cdp.send("Runtime.evaluate", { expression: "42" })).resolves.toMatchObject({ result: { value: 42 } });
    const waiting = expect(deadline(cdp.wait(new Promise<void>(() => {})))).rejects.toThrow("CDP session detached");
    await cdp.detach();
    await waiting;
    const send = vi.spyOn(session, "send");
    await expect(deadline(cdp.send("Runtime.evaluate", { expression: "42" }))).rejects.toThrow("CDP session detached");
    expect(send).not.toHaveBeenCalled();
    send.mockRestore();
    await expect(deadline(cdp.wait(new Promise<void>(() => {})))).rejects.toThrow("CDP session detached");
    await expect(page.evaluate(() => 42)).resolves.toBe(42);
    await page.close();
  } finally {
    await browser.close();
  }
});

test("capture startup and finalization retain both operation and detach errors", async () => {
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    const create = vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(session);
    const operationError = new Error("Profiler failed");
    const detachError = new Error("Detach failed");
    const send = vi.spyOn(session, "send").mockRejectedValue(operationError);
    const detach = vi.spyOn(session, "detach").mockRejectedValue(detachError);
    await expect(capture(page, { cpuProfilePath: "unused.cpuprofile" }, () => {})).rejects.toMatchObject({
      errors: [operationError, { errors: [detachError] }]
    });
    send.mockRestore();
    detach.mockRestore();
    create.mockRestore();
    await session.detach();

    const finalSession = await page.context().newCDPSession(page);
    const finalCreate = vi.spyOn(page.context(), "newCDPSession").mockResolvedValue(finalSession);
    const captures = await capture(page, { cpuProfilePath: "unused.cpuprofile" }, () => {});
    const finalSend = vi.spyOn(finalSession, "send").mockRejectedValue(operationError);
    const finalDetach = vi.spyOn(finalSession, "detach").mockRejectedValue(detachError);
    await expect(captures.finish(true)).rejects.toMatchObject({ errors: [operationError, detachError] });
    finalSend.mockRestore();
    finalDetach.mockRestore();
    finalCreate.mockRestore();
    await finalSession.detach();
  } finally {
    vi.restoreAllMocks();
    await browser.close();
  }
});

test("closing an external page releases its browser disconnect listener", async () => {
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage();
    const on = vi.spyOn(browser, "on");
    const off = vi.spyOn(browser, "off");
    const cdp = await openCdp(page);
    const disconnect = on.mock.calls.find(([event]) => event === "disconnected")?.[1];
    expect(disconnect).toBeTypeOf("function");
    await page.close();
    expect(browser.isConnected()).toBe(true);
    expect(off).toHaveBeenCalledWith("disconnected", disconnect);
    await expect(deadline(cdp.wait(new Promise<void>(() => {})))).rejects.toThrow("Page closed");
  } finally {
    vi.restoreAllMocks();
    await browser.close();
  }
});
