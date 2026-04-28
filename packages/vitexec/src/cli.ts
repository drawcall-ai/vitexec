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
import { buildVitexecUrl, uploadCode } from "./index.js";

export const VITEXEC_TIMEOUT_MS = 10 * 60 * 1000;

export type RunVitexecOptions = {
  gpu?: boolean;
  screenshotPath?: string;
  timeoutMs?: number;
};

export async function runVitexec(
  url: string,
  code: string,
  options: RunVitexecOptions = {}
): Promise<string> {
  const id = randomUUID();
  const logs: string[] = [];
  const timeoutMs = options.timeoutMs ?? VITEXEC_TIMEOUT_MS;

  await uploadCode(url, id, code);

  const browser = await launchBrowser(options);
  const page = await browser.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.setDefaultNavigationTimeout(timeoutMs);
  page.on("console", (message) => void collectConsole(logs, message));
  page.on("pageerror", (error) => logs.push(`[page error] ${error.message}`));
  page.on("requestfailed", (request) => logs.push(formatRequestFailure(request)));
  page.on("response", (response) => {
    if (response.status() >= 400) logs.push(formatHttpError(response));
  });

  try {
    const response = await page.goto(buildVitexecUrl(url, id), {
      timeout: timeoutMs,
      waitUntil: "networkidle"
    });

    if (!response) logs.push("[navigation] no response");
    if (response && !response.ok()) {
      logs.push(
        `[navigation] ${response.status()} ${response.statusText()} ${response.url()}`
      );
    }

    await page.waitForTimeout(100);
    if (options.screenshotPath) {
      await saveScreenshot(page, options.screenshotPath);
      logs.push(`[screenshot] ${options.screenshotPath}`);
    }
  } catch (error) {
    if (!isTimeoutError(error)) throw error;
    logs.push(`[error] timeout after ${formatDuration(timeoutMs)}: vitexec stopped waiting for the page.`);
  } finally {
    await browser.close();
  }

  return logs.join("\n");
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
    .description("Run a snippet inside a live Vite app and print browser logs.")
    .argument("<url>", "Vite dev server page URL")
    .argument("<code...>", "literal snippet to run")
    .option("--gpu", "use Chromium's new headless mode with GPU-friendly flags")
    .option("--screenshot <path>", "write a full-page screenshot after the code runs")
    .showHelpAfterError()
    .parse();

  const [url, codeParts] = program.processedArgs as [string, string[]];
  const options = program.opts<{
    gpu?: boolean;
    screenshot?: string;
  }>();

  const code = codeParts.join(" ");
  try {
    const logs = await runVitexec(url, code, {
      gpu: options.gpu,
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
