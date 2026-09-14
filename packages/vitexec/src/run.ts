import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { Readable } from "node:stream";
import type {
  Browser, BrowserContext, ConsoleMessage, Frame, Page, Request, Response, ViewportSize
} from "playwright";
import type { VitexecModuleExtension } from "./index.js";
import { startApp, appUrl } from "./app.js";
import { installInput, type Input } from "./input/playwright.js";
import { registerScript } from "./injection.js";
import { ensureParentDir } from "./files.js";
import { capture, saveScreenshot } from "./artifacts.js";

export const VITEXEC_TIMEOUT_MS = 10 * 60 * 1000;

export type PageRunOptions = {
  cpuProfilePath?: string;
  heapSnapshotPath?: string;
  moduleExtension?: VitexecModuleExtension;
  performanceTracePath?: string;
  /** Include audio in recordings. Defaults to true; the browser must have audio enabled. */
  recordAudio?: boolean;
  /** Recording frame rate. Defaults to 60. */
  recordFps?: number;
  recordPath?: string;
  screenshotPath?: string;
  /** Maximum time to wait for execution. Defaults to ten minutes. */
  timeoutMs?: number;
};

export type AppRunOptions = PageRunOptions & {
  configFile?: string | false;
  networkTracePath?: string;
  path?: string;
  root?: string;
  touch?: boolean;
  /** Context viewport as WIDTHxHEIGHT. Defaults to 1280x720. */
  viewport?: string;
};

/** Run in a fresh app context. The supplied browser is never closed. */
export function run(browser: Browser, code: string, options?: AppRunOptions): AsyncGenerator<string>;
/** Inject into the current document using its vitexec Vite plugin. Never navigates or closes the page. */
export function run(page: Page, code: string, options?: PageRunOptions): AsyncGenerator<string>;
export async function* run(
  target: Browser | Page,
  code: string,
  options: AppRunOptions = {}
): AsyncGenerator<string> {
  validateRunOptions(options);
  if ("newContext" in target) {
    yield* runApp(target, code, options);
    return;
  }
  for (const key of ["root", "configFile", "path", "viewport", "touch", "networkTracePath"] as const) {
    if (options[key] !== undefined) throw new Error(`${key} requires a Browser target, not an existing Page.`);
  }
  const id = randomUUID();
  if (activePages.has(target)) throw new Error("Vitexec is already running on this page.");
  activePages.add(target);
  try {
    const script = await registerScript(target, id, code, options.moduleExtension);
    try {
      yield* execute(
        { page: target, ownsContext: false, ownsPage: false }, id, options,
        () => target.evaluate<void>(
          `import(${JSON.stringify(script.url)}).then(() => undefined).catch(console.error.bind(console))`
        )
      );
    } finally {
      await script.dispose();
    }
  } finally {
    activePages.delete(target);
  }
}

const activePages = new WeakSet<Page>();

type Target = { page: Page; ownsContext: boolean; ownsPage: boolean };

// Also used by the published compatibility API, whose adopted pages still navigate.
export async function* runApp(
  resource: Browser | BrowserContext | Page,
  code: string,
  options: AppRunOptions
): AsyncGenerator<string> {
  validateRunOptions(options);
  const id = randomUUID();
  const server = await startApp(id, code, options);
  try {
    const target = await acquire(resource, options);
    try {
      yield* execute(target, id, options, async log => {
        const response = await navigateRunPage(target.page, appUrl(server, options.path),
          options.timeoutMs ?? VITEXEC_TIMEOUT_MS);
        if (!response) log("[navigation] no response");
        if (response && !response.ok()) {
          log(`[navigation] ${response.status()} ${response.statusText()} ${response.url()}`);
        }
      }, true);
    } finally {
      await closeTarget(target);
    }
    if (target.ownsContext && options.networkTracePath) {
      yield `[network-trace] ${options.networkTracePath}`;
    }
  } finally {
    await server.close();
  }
}

async function acquire(resource: Browser | BrowserContext | Page, options: AppRunOptions): Promise<Target> {
  const viewport = parseViewport(options.viewport);
  if ("goto" in resource) return { page: resource, ownsContext: false, ownsPage: false };
  if (!("newContext" in resource)) {
    return { page: await resource.newPage(), ownsContext: false, ownsPage: true };
  }
  const context = await createRunContext(resource, viewport, options);
  try {
    return { page: await context.newPage(), ownsContext: true, ownsPage: true };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function closeTarget(target: Target): Promise<void> {
  if (target.ownsContext) await target.page.context().close();
  else if (target.ownsPage) await target.page.close();
}

export function validateRunOptions(options: AppRunOptions): void {
  if (options.recordPath && extname(options.recordPath).toLowerCase() !== ".mp4") {
    throw new Error(`Recording path must end in .mp4: ${options.recordPath}`);
  }
  if (options.recordFps !== undefined && (!Number.isInteger(options.recordFps) || options.recordFps <= 0)) {
    throw new Error("recording frame rate must be a positive integer");
  }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error("timeoutMs must be a finite positive number");
  }
  parseViewport(options.viewport);
}

async function* execute(
  target: Target,
  id: string,
  options: AppRunOptions,
  start: (log: (line: string) => void) => Promise<void>,
  navigates = false
): AsyncGenerator<string> {
  const abort = new AbortController();
  const lines = new Readable({ objectMode: true, read() {} });
  const log = (line: string) => {
    if (!lines.destroyed) lines.push(line);
  };
  const task = executeTask(target, id, options, log, abort.signal, start, navigates);
  void task.then(
    () => lines.push(null),
    (error) => lines.destroy(error instanceof Error ? error : new Error(String(error)))
  );

  try {
    for await (const line of lines) {
      if (typeof line !== "string") throw new Error("Invalid Vitexec log entry.");
      yield line;
    }
    await task;
  } finally {
    abort.abort();
    lines.destroy();
    await task;
  }
}

async function executeTask(
  target: Target,
  id: string,
  options: AppRunOptions,
  log: (line: string) => void,
  signal: AbortSignal,
  start: (log: (line: string) => void) => Promise<void>,
  navigates: boolean
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
  const onRequestFailed = (request: Request) => log(formatRequestFailure(request));
  const onResponse = (response: Response) => {
    if (response.status() >= 400) log(formatHttpError(response));
  };
  const onFrameNavigated = (frame: Frame) => {
    if (frame !== target.page.mainFrame()) return;
    if (hasMainFrameNavigated) log(`[navigation] navigated ${frame.url()}`);
    hasMainFrameNavigated = true;
  };
  try {
    if (signal.aborted) return;
    const { page } = target;

    if (!target.ownsContext && options.networkTracePath) {
      log("[skipped] --network-trace needs a vitexec-created context; ignored for an adopted page/context");
    }

    captures = await capture(page, options, log);
    page.on("console", collectConsoleLog);
    page.on("pageerror", onPageError);
    page.on("requestfailed", onRequestFailed);
    page.on("response", onResponse);
    page.on("framenavigated", onFrameNavigated);
    input = await installInput(page);

    await completion.wait(start(log));
    if (navigates) await completion.wait(completion.promise);
    await releaseInput();
    if (options.screenshotPath) {
      await saveScreenshot(page, options.screenshotPath);
      log(`[screenshot] ${options.screenshotPath}`);
    }
  } catch (error) {
    if (signal.aborted) return;
    if (!isTimeoutError(error)) throw error;
    log(`[error] timeout after ${formatDuration(timeoutMs)}: vitexec stopped waiting for the page.`);
  } finally {
    completion.dispose();
    try {
      await Promise.all(pendingConsoleLogs);
      await releaseInput();
    } finally {
      target.page.off("console", collectConsoleLog);
      target.page.off("pageerror", onPageError);
      target.page.off("requestfailed", onRequestFailed);
      target.page.off("response", onResponse);
      target.page.off("framenavigated", onFrameNavigated);
      await captures?.finish(!signal.aborted);
    }
  }
}

// An adopted page reused across runs still shows the previous run's document,
// whose Vite server has since closed. Navigating away cancels that orphaned
// document's now-failing requests, which Chromium can surface as a one-off
// net::ERR_ABORTED on the new navigation. Retry that exact case once; the second
// attempt starts clean. A genuine navigation failure still throws both times.
async function navigateRunPage(
  page: Page,
  url: string,
  timeoutMs: number
): Promise<Response | null> {
  try {
    return await page.goto(url, { timeout: timeoutMs, waitUntil: "load" });
  } catch (error) {
    if (!isAbortedNavigationError(error)) throw error;
    return page.goto(url, { timeout: timeoutMs, waitUntil: "load" });
  }
}

function isAbortedNavigationError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("net::ERR_ABORTED");
}

async function createRunContext(
  browser: Browser,
  viewport: ViewportSize | null,
  options: AppRunOptions
): Promise<BrowserContext> {
  if (options.networkTracePath) await ensureParentDir(options.networkTracePath);
  const effectiveViewport = viewport ?? { width: 1280, height: 720 };
  return browser.newContext({
    ignoreHTTPSErrors: true,
    hasTouch: options.touch,
    viewport: effectiveViewport,
    ...(options.networkTracePath ? { recordHar: { path: options.networkTracePath } } : {})
  });
}

// "390x844" -> { width: 390, height: 844 }. Throws on a malformed value rather than silently
// falling back to the default, so a bad --viewport surfaces instead of testing the wrong size.
function parseViewport(value: string | undefined): ViewportSize | null {
  if (!value) return null;
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`invalid --viewport "${value}" — expected WIDTHxHEIGHT, e.g. 390x844`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("invalid --viewport: dimensions must be positive integers");
  }
  return { width, height };
}

function createCompletion(timeoutMs: number, signal: AbortSignal) {
  let resolveCompletion: (() => void) | undefined;
  let rejectInterruption: ((error: Error) => void) | undefined;
  const promise = new Promise<void>(resolve => { resolveCompletion = resolve; });
  const interrupted = new Promise<never>((_resolve, reject) => { rejectInterruption = reject; });
  // Capture setup can still be pending when cancellation arrives, before wait() is called.
  void interrupted.catch(() => undefined);
  const abort = () => rejectInterruption?.(createAbortError());
  const timer = setTimeout(() => rejectInterruption?.(createTimeoutError()), timeoutMs);
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
  if (isIgnoredBrowserConsoleMessage(message)) return;

  const values = await Promise.all(
    message.args().map(async (argument) => argument.jsonValue().catch(() => argument.toString()))
  );
  const text = values.length ? values.map(formatValue).join(" ") : message.text();
  log(`[${message.type()}] ${text}`);
}

function isBrowserResourceError(message: ConsoleMessage): boolean {
  return (
    message.type() === "error" &&
    message.text().startsWith("Failed to load resource:")
  );
}

function isIgnoredBrowserConsoleMessage(message: ConsoleMessage): boolean {
  return isBrowserResourceError(message) || isViteClientDebugMessage(message);
}

function isViteClientDebugMessage(message: ConsoleMessage): boolean {
  return message.type() === "debug" && message.text().startsWith("[vite] ");
}

function formatHttpError(response: Response): string {
  const request = response.request();
  return `[http ${response.status()}] ${request.method()} ${response.url()} ${response.statusText()}`;
}

function formatRequestFailure(request: Request): string {
  return `[request failed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown error"}`;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function createTimeoutError(): Error {
  const error = new Error("Timed out waiting for injected code.");
  error.name = "TimeoutError";
  return error;
}

function createAbortError(): Error {
  const error = new Error("Vitexec run aborted.");
  error.name = "AbortError";
  return error;
}

function formatDuration(ms: number): string {
  return ms === VITEXEC_TIMEOUT_MS ? "10m" : `${ms}ms`;
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

