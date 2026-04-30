#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response
} from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { vitexec, type VitexecModuleExtension } from "./index.js";

declare global {
  var __vitexecRuns: Record<string, Promise<unknown> | undefined>;
}

export const VITEXEC_TIMEOUT_MS = 10 * 60 * 1000;

export type RunVitexecOptions = {
  configFile?: string | false;
  gpu?: boolean;
  moduleExtension?: VitexecModuleExtension;
  path?: string;
  recordPath?: string;
  root?: string;
  screenshotPath?: string;
  timeoutMs?: number;
};

export async function* runVitexec(
  code: string,
  options: RunVitexecOptions = {}
): AsyncGenerator<string> {
  const id = randomUUID();
  const server = await startViteServer(id, code, options);

  try {
    yield* runVitexecInServer(server, id, options);
  } finally {
    await server.close();
  }
}

export async function resolveVitexecCodeInput(
  codeParts: string[],
  cwd = process.cwd()
): Promise<string> {
  return (await resolveVitexecCodeInputDetails(codeParts, cwd)).code;
}

export type ResolvedVitexecCodeInput = {
  code: string;
  moduleExtension: VitexecModuleExtension;
};

export async function resolveVitexecCodeInputDetails(
  codeParts: string[],
  cwd = process.cwd()
): Promise<ResolvedVitexecCodeInput> {
  if (codeParts.length !== 1) {
    return { code: codeParts.join(" "), moduleExtension: ".js" };
  }

  const input = codeParts[0];
  const filePath = resolve(cwd, input);
  if (!(await isFile(filePath))) return { code: input, moduleExtension: ".js" };

  return {
    code: await readFile(filePath, "utf8"),
    moduleExtension: moduleExtensionFromPath(filePath)
  };
}

function moduleExtensionFromPath(path: string): VitexecModuleExtension {
  const extension = extname(path);
  return isModuleExtension(extension) ? extension : ".js";
}

function isModuleExtension(value: string): value is VitexecModuleExtension {
  return [".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(value);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isFileMissingError(error)) return false;
    throw error;
  }
}

function isFileMissingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ENOTDIR" ||
      error.code === "ENAMETOOLONG")
  );
}

async function* runVitexecInServer(
  server: ViteDevServer,
  id: string,
  options: RunVitexecOptions
): AsyncGenerator<string> {
  const abort = new AbortController();
  const lines = new Readable({ objectMode: true, read() {} });
  const log = (line: string) => {
    if (!lines.destroyed) lines.push(line);
  };
  const run = runVitexecInServerTask(server, id, options, log, abort.signal).then(
    () => lines.push(null),
    (error) => lines.destroy(error instanceof Error ? error : new Error(String(error)))
  );

  try {
    for await (const line of lines) yield line as string;
    await run;
  } finally {
    abort.abort();
    lines.destroy();
    await run.catch(() => undefined);
  }
}

async function runVitexecInServerTask(
  server: ViteDevServer,
  id: string,
  options: RunVitexecOptions,
  log: (line: string) => void,
  signal: AbortSignal
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? VITEXEC_TIMEOUT_MS;
  const url = buildServerPageUrl(server, options.path);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  const closeBrowser = () => void browser?.close().catch(() => undefined);

  const pendingConsoleLogs = new Set<Promise<void>>();
  const collectConsoleLog = (message: ConsoleMessage) => {
    const pendingLog = collectConsole(log, message);
    pendingConsoleLogs.add(pendingLog);
    pendingLog.finally(() => pendingConsoleLogs.delete(pendingLog));
  };
  try {
    browser = await launchBrowser(options);
    signal.addEventListener("abort", closeBrowser, { once: true });
    if (signal.aborted) return;

    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      ...(options.recordPath && !signal.aborted
        ? { recordVideo: { dir: dirname(options.recordPath) } }
        : {})
    });
    page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    page.on("console", collectConsoleLog);
    page.on("pageerror", (error) => log(`[page error] ${error.message}`));
    page.on("requestfailed", (request) => log(formatRequestFailure(request)));
    page.on("response", (response) => {
      if (response.status() >= 400) log(formatHttpError(response));
    });
    let hasMainFrameNavigated = false;
    page.on("framenavigated", (frame) => {
      if (frame !== page?.mainFrame()) return;
      if (hasMainFrameNavigated) {
        log(`[navigation] navigated ${frame.url()}`);
      }
      hasMainFrameNavigated = true;
    });
    const injectedCodeFinished = createInjectedCodeCompletion(timeoutMs, signal);
    await page.exposeFunction("__vitexecReport", injectedCodeFinished.resolve);

    const response = await page.goto(url, {
      timeout: timeoutMs,
      waitUntil: "load"
    });
    if (!response) log("[navigation] no response");
    if (response && !response.ok()) {
      log(`[navigation] ${response.status()} ${response.statusText()} ${response.url()}`);
    }

    await injectedCodeFinished.promise;
    if (options.screenshotPath) {
      await saveScreenshot(page, options.screenshotPath);
      log(`[screenshot] ${options.screenshotPath}`);
    }
  } catch (error) {
    if (signal.aborted) return;
    if (!isTimeoutError(error)) throw error;
    log(`[error] timeout after ${formatDuration(timeoutMs)}: vitexec stopped waiting for the page.`);
  } finally {
    await Promise.allSettled(pendingConsoleLogs);
    try {
      if (page && options.recordPath && !signal.aborted) {
        await saveRecording(page, options.recordPath);
        log(`[recording] ${options.recordPath}`);
      }
    } finally {
      signal.removeEventListener("abort", closeBrowser);
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }
}

async function startViteServer(
  id: string,
  code: string,
  options: RunVitexecOptions
): Promise<ViteDevServer> {
  const server = await createServer({
    configFile: options.configFile,
    root: options.root,
    logLevel: "silent",
    server: {
      hmr: false,
      host: "127.0.0.1",
      open: false,
      port: 0,
      strictPort: false,
      watch: null
    },
    plugins: [vitexec({ code, id, moduleExtension: options.moduleExtension })]
  });

  await server.listen();
  return server;
}

function buildServerPageUrl(server: ViteDevServer, path = "/"): string {
  const base = server.resolvedUrls?.local[0];
  if (base) return new URL(normalizePagePath(path), base).toString();

  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start Vite server.");
  }

  return new URL(normalizePagePath(path), `http://127.0.0.1:${address.port}/`).toString();
}

function normalizePagePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function launchBrowser(options: RunVitexecOptions): Promise<Browser> {
  return chromium.launch({
    channel: options.gpu ? "chromium" : undefined,
    args: options.gpu ? ["--enable-gpu", "--ignore-gpu-blocklist"] : undefined
  });
}

async function saveScreenshot(
  page: Page,
  path: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

function createInjectedCodeCompletion(timeoutMs: number, signal: AbortSignal): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;
  const abort = () => rejectCompletion?.(createAbortError());
  const promise = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
    timeout = setTimeout(() => reject(createTimeoutError()), timeoutMs);
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  });
  promise.catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  return {
    promise,
    resolve() {
      resolveCompletion?.();
    }
  };
}

async function saveRecording(
  page: Page,
  path: string
): Promise<void> {
  const video = page.video();
  if (!video) throw new Error("Recording was requested, but Playwright did not create a video.");

  await mkdir(dirname(path), { recursive: true });
  await page.close();
  await video.saveAs(path);
  await video.delete().catch(() => undefined);
}

async function collectConsole(
  log: (line: string) => void,
  message: ConsoleMessage
): Promise<void> {
  if (isBrowserResourceError(message)) return;

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

async function main(): Promise<void> {
  const program = new Command()
    .name("vitexec")
    .description("Run a snippet inside a Vite app and print browser logs.")
    .argument("<code-or-file...>", "literal snippet to run, or a path to a snippet file")
    .option("--config <path>", "use a specific Vite config file")
    .option("--gpu", "use Chromium's new headless mode with GPU-friendly flags")
    .option("--path <path>", "Vite page path to open", "/")
    .option("--record <path>", "write a WebM video recording after the code runs")
    .option("--screenshot <path>", "write a full-page screenshot after the code runs")
    .option("--timeout <seconds>", "maximum time to wait for navigation and injected code", parseTimeoutSeconds)
    .showHelpAfterError()
    .parse();

  const [codeParts] = program.processedArgs as [string[]];
  const options = program.opts<{
    config?: string;
    gpu?: boolean;
    path?: string;
    record?: string;
    screenshot?: string;
    timeout?: number;
  }>();

  try {
    const input = await resolveVitexecCodeInputDetails(codeParts);
    process.stdout.write("logs:\n");
    let hasLogs = false;
    for await (const line of runVitexec(input.code, {
      configFile: options.config,
      gpu: options.gpu,
      moduleExtension: input.moduleExtension,
      path: options.path,
      recordPath: options.record,
      screenshotPath: options.screenshot,
      timeoutMs: options.timeout === undefined ? undefined : options.timeout * 1000
    })) {
      hasLogs = true;
      process.stdout.write(`${line}\n`);
    }
    if (!hasLogs) process.stdout.write("(no browser logs captured)\n");
  } catch (error) {
    console.error(`vitexec failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function parseTimeoutSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new InvalidArgumentError("timeout must be a positive number of seconds");
  }

  return seconds;
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  void main();
}
