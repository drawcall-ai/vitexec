import { openBrowser } from "./browser.js";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type {
  Browser, BrowserContext, ConsoleMessage, Frame, Page, Request, Response
} from "playwright";
import { validateRunOptions, parseViewport, VITEXEC_TIMEOUT_MS, type AppRunOptions } from "./options.js";
import { startApp, appUrl } from "./app.js";
import { installInput, type Input } from "./input/playwright.js";
import { ensureParentDir } from "./files.js";
import { capture, saveScreenshot } from "./artifacts.js";

export type RunVitexecOptions = AppRunOptions & {
  browserArgs?: string[];
  browserExposeNetwork?: string;
  browserWsEndpoint?: string;
  gpu?: boolean;
  /**
   * Run inside a browser you already own instead of launching one. vitexec opens
   * a fresh context + page in it and never closes the browser (only that context).
   */
  browser?: Browser;
  /**
   * Run inside a context you already own. vitexec opens a fresh page in it and
   * closes only that page — never the context or its browser.
   */
  context?: BrowserContext;
  /**
   * Run inside a page you already own — e.g. a dev server's visible managed tab.
   * vitexec navigates it to its own per-run URL, runs the snippet, and never
   * closes the page/context/browser. The same page may be reused across runs.
   * Same-process only: a Page is a live RPC proxy bound to its owning process.
   */
  page?: Page;
};

/** @deprecated Use openPage(), run(page, code), and page.close(). */
export async function* runVitexec(code: string, options: RunVitexecOptions = {}): AsyncGenerator<string> {
  validateRunOptions(options);
  const abort = new AbortController();
  const lines = new Readable({ objectMode: true, read() {} });
  const log = (line: string) => { if (!lines.destroyed) lines.push(line); };
  const task = execute(code, options, log, abort.signal);
  void task.then(
    () => lines.push(null),
    error => lines.destroy(error instanceof Error ? error : new Error(String(error)))
  );
  try {
    for await (const line of lines) {
      if (typeof line !== "string") throw new Error("Invalid Vitexec log entry.");
      yield line;
    }
  } finally {
    abort.abort();
    lines.destroy();
    await task;
  }
}

async function execute(code: string, options: RunVitexecOptions, log: (line: string) => void, signal: AbortSignal) {
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let server: Awaited<ReturnType<typeof startApp>> | undefined;
  try {
    const resource = options.page ?? options.context ?? options.browser ?? (browser = await openBrowser({
      ...options, gpu: options.gpu ?? false,
      audio: Boolean(options.recordPath) && options.recordAudio !== false, log
    }));
    if (signal.aborted) return;
    const id = randomUUID();
    server = await startApp(id, code, options);
    if ("goto" in resource) page = resource;
    else if (!("newContext" in resource)) page = await resource.newPage();
    else {
      if (options.networkTracePath) await ensureParentDir(options.networkTracePath);
      context = await resource.newContext({
        ignoreHTTPSErrors: true, hasTouch: options.touch,
        viewport: parseViewport(options.viewport) ?? { width: 1280, height: 720 },
        ...(options.networkTracePath ? { recordHar: { path: options.networkTracePath } } : {})
      });
      page = await context.newPage();
    }
    if (!context && options.networkTracePath) {
      log("[skipped] --network-trace needs a vitexec-created context; ignored for an adopted page/context");
    }
    await executePage(page, id, options, log, signal, appUrl(server, options.path));
  } finally {
    try {
      if (context) {
        await context.close();
        if (options.networkTracePath) log(`[network-trace] ${options.networkTracePath}`);
      } else if (page && page !== options.page) await page.close();
    } finally {
      try { await server?.close(); } finally { await browser?.close(); }
    }
  }
}

async function executePage(
  page: Page,
  id: string,
  options: AppRunOptions,
  log: (line: string) => void,
  signal: AbortSignal,
  url: string
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? VITEXEC_TIMEOUT_MS;
  let captures: Awaited<ReturnType<typeof capture>> | undefined;
  const completion = createCompletion(timeoutMs, signal);
  let input: Input | undefined;
  const releaseInput = async () => {
    const active = input;
    input = undefined;
    await active?.release();
  };

  const pendingConsoleLogs = new Set<Promise<void>>();
  const collectConsoleLog = (message: ConsoleMessage) => {
    if (message.type() === "debug" && message.text() === id) {
      completion.resolve();
      return;
    }

    const pendingLog = collectConsole(log, message).catch(error => {
      log(`[console error] ${String(error)}`);
    });
    pendingConsoleLogs.add(pendingLog);
    pendingLog.finally(() => pendingConsoleLogs.delete(pendingLog));
  };
  let hasMainFrameNavigated = false;
  const onPageError = (error: Error) => log(`[page error] ${error.message}`);
  const onRequestFailed = (request: Request) => log(`[request failed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown error"}`);
  const onResponse = (response: Response) => {
    if (response.status() >= 400) log(`[http ${response.status()}] ${response.request().method()} ${response.url()} ${response.statusText()}`);
  };
  const onFrameNavigated = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    if (hasMainFrameNavigated) log(`[navigation] navigated ${frame.url()}`);
    hasMainFrameNavigated = true;
  };
  try {
    if (signal.aborted) return;
    captures = await capture(page, options, log);
    page.on("console", collectConsoleLog);
    page.on("pageerror", onPageError);
    page.on("requestfailed", onRequestFailed);
    page.on("response", onResponse);
    page.on("framenavigated", onFrameNavigated);
    input = await installInput(page);

    const response = await completion.wait(navigate(page, url, timeoutMs));
    if (!response) log("[navigation] no response");
    if (response && !response.ok()) log(`[navigation] ${response.status()} ${response.statusText()} ${response.url()}`);
    await completion.wait(completion.promise);
    await releaseInput();
    if (options.screenshotPath) {
      await saveScreenshot(page, options.screenshotPath);
      log(`[screenshot] ${options.screenshotPath}`);
    }
  } catch (error) {
    if (signal.aborted) return;
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    log(`[error] timeout after ${timeoutMs === VITEXEC_TIMEOUT_MS ? "10m" : `${timeoutMs}ms`}: vitexec stopped waiting for the page.`);
  } finally {
    completion.dispose();
    try {
      await Promise.all(pendingConsoleLogs);
      await releaseInput();
    } finally {
      page.off("console", collectConsoleLog);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
      page.off("framenavigated", onFrameNavigated);
      await captures?.finish(!signal.aborted);
    }
  }
}

// An adopted page reused across runs still shows the previous run's document,
// whose Vite server has since closed. Navigating away cancels that orphaned
// document's now-failing requests, which Chromium can surface as a one-off
// net::ERR_ABORTED on the new navigation. Retry that exact case once; the second
// attempt starts clean. A genuine navigation failure still throws both times.
async function navigate(
  page: Page,
  url: string,
  timeoutMs: number
): Promise<Response | null> {
  try {
    return await page.goto(url, { timeout: timeoutMs, waitUntil: "load" });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("net::ERR_ABORTED")) throw error;
    return page.goto(url, { timeout: timeoutMs, waitUntil: "load" });
  }
}

function createCompletion(timeoutMs: number, signal: AbortSignal) {
  let resolveCompletion: (() => void) | undefined;
  let rejectInterruption: ((error: Error) => void) | undefined;
  const promise = new Promise<void>(resolve => { resolveCompletion = resolve; });
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterruption = reject; });
  // Capture setup can still be pending when cancellation arrives, before wait() is called.
  void interrupted.catch(() => undefined);
  const abort = () => rejectInterruption?.(new Error("Vitexec run aborted."));
  const timer = setTimeout(() => rejectInterruption?.(Object.assign(new Error("Timed out waiting for injected code."), { name: "TimeoutError" })), timeoutMs);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  return {
    promise,
    resolve() { resolveCompletion?.(); },
    wait<T>(pending: Promise<T>): Promise<T> { return Promise.race([pending, interrupted]); },
    dispose() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  };
}

async function collectConsole(
  log: (line: string) => void,
  message: ConsoleMessage
): Promise<void> {
  if (message.type() === "error" && message.text().startsWith("Failed to load resource:")) return;
  if (message.type() === "debug" && message.text().startsWith("[vite] ")) return;

  const values = await Promise.all(
    message.args().map(async (argument) => argument.jsonValue().catch(() => argument.toString()))
  );
  const text = values.length ? values.map(formatValue).join(" ") : message.text();
  log(`[${message.type()}] ${text}`);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
