#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import type { Browser, BrowserContext, Page } from "playwright";
import type { VitexecModuleExtension } from "./index.js";
import { createBrowser } from "./browser.js";
import { runApp, validateRunOptions, type AppRunOptions } from "./run.js";

export { createBrowser, createBrowserArgs, createRemoteBrowserHeaders, ensureChromiumInstalled,
  VITEXEC_DEFAULT_REMOTE_EXPOSE_NETWORK, VITEXEC_LOCAL_GPU_BROWSER_ARGS,
  VITEXEC_REMOTE_GPU_BROWSER_ARGS } from "./browser.js";
export type { CreateBrowserOptions } from "./browser.js";
export { run, VITEXEC_TIMEOUT_MS } from "./run.js";
export type { AppRunOptions, PageRunOptions } from "./run.js";
export type { VitexecModuleExtension };

export const VITEXEC_ENV = {
  browserArgs: "VITEXEC_BROWSER_ARGS",
  browserExposeNetwork: "VITEXEC_BROWSER_EXPOSE_NETWORK",
  browserWsEndpoint: "VITEXEC_BROWSER_WS_ENDPOINT",
  config: "VITEXEC_CONFIG",
  cpuProfile: "VITEXEC_CPU_PROFILE",
  gpu: "VITEXEC_GPU",
  heapSnapshot: "VITEXEC_HEAP_SNAPSHOT",
  networkTrace: "VITEXEC_NETWORK_TRACE",
  path: "VITEXEC_PATH",
  performanceTrace: "VITEXEC_PERFORMANCE_TRACE",
  record: "VITEXEC_RECORD",
  recordAudio: "VITEXEC_RECORD_AUDIO",
  recordFps: "VITEXEC_RECORD_FPS",
  screenshot: "VITEXEC_SCREENSHOT",
  touch: "VITEXEC_TOUCH",
  timeout: "VITEXEC_TIMEOUT",
  viewport: "VITEXEC_VIEWPORT"
} as const;
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

type Environment = Record<string, string | undefined>;

type CliOptions = {
  browserArg?: string[];
  browserExposeNetwork?: string;
  browserWsEndpoint?: string;
  config?: string;
  cpuProfile?: string;
  gpu?: boolean;
  heapSnapshot?: string;
  networkTrace?: string;
  path?: string;
  performanceTrace?: string;
  record?: string;
  recordAudio?: boolean;
  recordFps?: number;
  screenshot?: string;
  touch?: boolean;
  viewport?: string;
  timeout?: number;
};

/**
 * @deprecated Use createBrowser() and run(). Replace a standalone run with:
 * ```ts
 * import { createBrowser, run } from "vitexec/cli";
 *
 * const browser = await createBrowser({
 *   ...options,
 *   gpu: options.gpu ?? false,
 *   audio: Boolean(options.recordPath) && options.recordAudio !== false,
 * });
 * try {
 *   for await (const line of run(browser, code, options)) {
 *     console.log(line);
 *   }
 * } finally {
 *   await browser.close();
 * }
 * ```
 * For an existing browser, use `run(browser, code, options)` directly.
 * Unlike this legacy function, `run(page, code)` injects without navigation
 * and requires the running app's vitexec Vite plugin.
 */
export async function* runVitexec(
  code: string,
  options: RunVitexecOptions = {}
): AsyncGenerator<string> {
  validateRunOptions(options);
  const target = options.page ?? options.context ?? options.browser;
  if (target) {
    yield* runApp(target, code, options);
    return;
  }
  const logs: string[] = [];
  const browser = await createBrowser({
    ...options,
    gpu: options.gpu ?? false,
    audio: Boolean(options.recordPath) && options.recordAudio !== false,
    log: line => logs.push(line)
  });
  try {
    yield* logs;
    yield* runApp(browser, code, options);
  } finally {
    await browser.close();
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
  const directPath = resolve(cwd, input);
  const vitexecPath = resolve(cwd, "vitexec", input);
  let filePath: string | undefined;
  if (await isFile(directPath)) filePath = directPath;
  else if (await isFile(vitexecPath)) filePath = vitexecPath;
  if (!filePath) return { code: input, moduleExtension: ".js" };

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

async function main(): Promise<void> {
  const program = new Command()
    .name("vitexec")
    .description("Run a snippet inside a Vite app and print browser logs.")
    .argument("<code-or-file...>", "literal snippet to run, or a path to a snippet file")
    .option(
      "--browser-arg <arg>",
      "extra Chromium launch argument; repeat or set VITEXEC_BROWSER_ARGS as a JSON string array",
      collectBrowserArg,
      []
    )
    .option(
      "--browser-expose-network <rules>",
      "network rules exposed from this machine to a remote Playwright browser"
    )
    .option("--config <path>", "use a specific Vite config file")
    .option("--cpu-profile <path>", "write a Chrome/V8 CPU profile after the code runs")
    .option("--gpu", "use Chromium's new headless mode with GPU-friendly flags")
    .option("--heap-snapshot <path>", "write an agent-friendly heap snapshot summary after the code runs")
    .option("--network-trace <path>", "write a HAR network trace after the code runs")
    .option("--path <path>", "Vite page path to open")
    .option("--performance-trace <path>", "write a Chrome performance trace after the code runs")
    .option("--record <path>", "write an MP4 recording (60 FPS with page audio by default)")
    .option("--record-audio", "include page audio in the recording (default)")
    .option("--record-fps <fps>", "recording frame rate", parseRecordFps)
    .option("--no-record-audio", "omit page audio from the recording")
    .option(
      "--browser-ws-endpoint <ws-endpoint>",
      "Playwright browser WebSocket endpoint to connect to instead of launching Chromium locally"
    )
    .option("--screenshot <path>", "write a full-page screenshot after the code runs")
    .option("--touch", "emulate touch input and a coarse pointer")
    .option("--viewport <WIDTHxHEIGHT>", "browser viewport, e.g. 390x844 for a phone (default 1280x720)")
    .option("--timeout <seconds>", "maximum time to wait for navigation and injected code", parseTimeoutSeconds)
    .showHelpAfterError()
    .parse();

  const codeParts: unknown = program.processedArgs[0];
  if (!Array.isArray(codeParts) || !codeParts.every((part): part is string => typeof part === "string")) {
    throw new Error("Expected code or file arguments.");
  }
  const options = program.opts<CliOptions>();

  try {
    const input = await resolveVitexecCodeInputDetails(codeParts);
    process.stdout.write("logs:\n");
    let hasLogs = false;
    for await (const line of runVitexec(input.code, createRunOptions(options, {
      env: process.env,
      moduleExtension: input.moduleExtension
    }))) {
      hasLogs = true;
      process.stdout.write(`${line}\n`);
    }
    if (!hasLogs) process.stdout.write("(no browser logs captured)\n");
  } catch (error) {
    console.error(`vitexec failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export function createRunOptions(
  options: CliOptions,
  context: {
    env?: Environment;
    moduleExtension?: VitexecModuleExtension;
  } = {}
): RunVitexecOptions {
  const env = context.env ?? process.env;
  const timeout = options.timeout ?? envNumber(env, VITEXEC_ENV.timeout, parseTimeoutSeconds);
  const browserArgs = normalizeBrowserArgs(
    options.browserArg,
    envString(env, VITEXEC_ENV.browserArgs)
  );

  return {
    ...(browserArgs ? { browserArgs } : {}),
    browserExposeNetwork: options.browserExposeNetwork ?? envString(env, VITEXEC_ENV.browserExposeNetwork),
    browserWsEndpoint: options.browserWsEndpoint ?? envString(env, VITEXEC_ENV.browserWsEndpoint),
    configFile: options.config ?? envString(env, VITEXEC_ENV.config),
    cpuProfilePath: options.cpuProfile ?? envString(env, VITEXEC_ENV.cpuProfile),
    gpu: options.gpu ?? envBoolean(env, VITEXEC_ENV.gpu),
    heapSnapshotPath: options.heapSnapshot ?? envString(env, VITEXEC_ENV.heapSnapshot),
    moduleExtension: context.moduleExtension,
    networkTracePath: options.networkTrace ?? envString(env, VITEXEC_ENV.networkTrace),
    path: options.path ?? envString(env, VITEXEC_ENV.path),
    performanceTracePath: options.performanceTrace ?? envString(env, VITEXEC_ENV.performanceTrace),
    recordAudio: options.recordAudio ?? envBoolean(env, VITEXEC_ENV.recordAudio),
    recordFps: options.recordFps ?? envNumber(env, VITEXEC_ENV.recordFps, parseRecordFps),
    recordPath: options.record ?? envString(env, VITEXEC_ENV.record),
    screenshotPath: options.screenshot ?? envString(env, VITEXEC_ENV.screenshot),
    touch: options.touch ?? envBoolean(env, VITEXEC_ENV.touch),
    viewport: options.viewport ?? envString(env, VITEXEC_ENV.viewport),
    timeoutMs: timeout === undefined ? undefined : timeout * 1000
  };
}

function collectBrowserArg(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function normalizeBrowserArgs(
  cliArgs: string[] | undefined,
  envValue: string | undefined
): string[] | undefined {
  if (cliArgs && cliArgs.length > 0) return cliArgs;
  if (envValue === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(envValue);
  } catch {
    throw new InvalidArgumentError(`${VITEXEC_ENV.browserArgs} must be a JSON string array`);
  }

  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new InvalidArgumentError(`${VITEXEC_ENV.browserArgs} must be a JSON string array`);
  }

  return parsed.length > 0 ? parsed : undefined;
}

function parseTimeoutSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new InvalidArgumentError("timeout must be a positive number of seconds");
  }

  return seconds;
}

function parseRecordFps(value: string): number {
  const fps = Number(value);
  validateRecordFps(fps);
  return fps;
}

function validateRecordFps(fps: number): void {
  if (!Number.isInteger(fps) || fps <= 0) {
    throw new InvalidArgumentError("recording frame rate must be a positive integer");
  }
}

function envString(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function envNumber(
  env: Environment,
  name: string,
  parse: (value: string) => number
): number | undefined {
  const value = envString(env, name);
  return value === undefined ? undefined : parse(value);
}

function envBoolean(env: Environment, name: string): boolean | undefined {
  const value = envString(env, name);
  if (value === undefined) return undefined;

  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new InvalidArgumentError(`${name} must be one of: 1, 0, true, false, yes, no, on, off`);
  }
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
