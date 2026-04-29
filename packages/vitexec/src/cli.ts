#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  chromium,
  type Browser,
  type ConsoleMessage,
  type Request,
  type Response
} from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { vitexec } from "./index.js";

declare global {
  var __vitexecRuns: Record<string, Promise<unknown> | undefined>;
}

export const VITEXEC_TIMEOUT_MS = 10 * 60 * 1000;

export type RunVitexecOptions = {
  configFile?: string | false;
  gpu?: boolean;
  path?: string;
  recordPath?: string;
  root?: string;
  screenshotPath?: string;
  timeoutMs?: number;
};

export async function runVitexec(
  code: string,
  options: RunVitexecOptions = {}
): Promise<string> {
  const id = randomUUID();
  const server = await startViteServer(id, code, options);

  try {
    return await runVitexecInServer(server, id, options);
  } finally {
    await server.close();
  }
}

async function runVitexecInServer(
  server: ViteDevServer,
  id: string,
  options: RunVitexecOptions
): Promise<string> {
  const logs: string[] = [];
  const timeoutMs = options.timeoutMs ?? VITEXEC_TIMEOUT_MS;
  const url = buildServerPageUrl(server, options.path);

  const browser = await launchBrowser(options);
  const context = options.recordPath
    ? await browser.newContext({
        recordVideo: {
          dir: dirname(options.recordPath)
        }
      })
    : undefined;
  const page = context ? await context.newPage() : await browser.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);
  page.on("console", (message) => void collectConsole(logs, message));
  page.on("pageerror", (error) => logs.push(`[page error] ${error.message}`));
  page.on("requestfailed", (request) => logs.push(formatRequestFailure(request)));
  page.on("response", (response) => {
    if (response.status() >= 400) logs.push(formatHttpError(response));
  });

  try {
    const response = await page.goto(url, {
      timeout: timeoutMs,
      waitUntil: "networkidle"
    });

    if (!response) logs.push("[navigation] no response");
    if (response && !response.ok()) {
      logs.push(
        `[navigation] ${response.status()} ${response.statusText()} ${response.url()}`
      );
    }

    await waitForInjectedCode(page, id);
    if (options.screenshotPath) {
      await saveScreenshot(page, options.screenshotPath);
      logs.push(`[screenshot] ${options.screenshotPath}`);
    }
  } catch (error) {
    if (!isTimeoutError(error)) throw error;
    logs.push(`[error] timeout after ${formatDuration(timeoutMs)}: vitexec stopped waiting for the page.`);
  } finally {
    if (options.recordPath) {
      await saveRecording(page, options.recordPath);
      logs.push(`[recording] ${options.recordPath}`);
    }
    await context?.close();
    await browser.close();
  }

  return logs.join("\n");
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
      host: "127.0.0.1",
      open: false,
      port: 0,
      strictPort: false
    },
    plugins: [vitexec({ code, id })]
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
  page: Awaited<ReturnType<Browser["newPage"]>>,
  path: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await page.screenshot({ path, fullPage: true });
}

async function waitForInjectedCode(
  page: Awaited<ReturnType<Browser["newPage"]>>,
  id: string
): Promise<void> {
  await page.waitForFunction(
    (runId) => Boolean(globalThis.__vitexecRuns?.[runId]),
    id
  );
  await page.evaluate((runId) => globalThis.__vitexecRuns[runId], id);
}

async function saveRecording(
  page: Awaited<ReturnType<Browser["newPage"]>>,
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
  logs: string[],
  message: ConsoleMessage
): Promise<void> {
  if (isBrowserResourceError(message)) return;

  const values = await Promise.all(
    message.args().map(async (argument) => argument.jsonValue().catch(() => argument.toString()))
  );
  const text = values.length ? values.map(formatValue).join(" ") : message.text();
  logs.push(`[${message.type()}] ${text}`);
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

function formatDuration(ms: number): string {
  return ms === VITEXEC_TIMEOUT_MS ? "10m" : `${ms}ms`;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function main(): Promise<void> {
  const program = new Command()
    .name("vitexec")
    .description("Run a snippet inside a Vite app and print browser logs.")
    .argument("<code...>", "literal snippet to run")
    .option("--config <path>", "use a specific Vite config file")
    .option("--gpu", "use Chromium's new headless mode with GPU-friendly flags")
    .option("--path <path>", "Vite page path to open", "/")
    .option("--record <path>", "write a WebM video recording after the code runs")
    .option("--screenshot <path>", "write a full-page screenshot after the code runs")
    .showHelpAfterError()
    .parse();

  const [codeParts] = program.processedArgs as [string[]];
  const options = program.opts<{
    config?: string;
    gpu?: boolean;
    path?: string;
    record?: string;
    screenshot?: string;
  }>();

  const code = codeParts.join(" ");
  try {
    const logs = await runVitexec(code, {
      configFile: options.config,
      gpu: options.gpu,
      path: options.path,
      recordPath: options.record,
      screenshotPath: options.screenshot
    });
    console.log(formatCliOutput(logs));
  } catch (error) {
    console.error(`vitexec failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

function formatCliOutput(logs: string): string {
  return `logs:\n${logs || "(no browser logs captured)"}`;
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
