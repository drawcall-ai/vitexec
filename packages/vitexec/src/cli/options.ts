import { Command, InvalidArgumentError } from "commander";
import type { VitexecModuleExtension } from "../index.js";
import type { AppRunOptions } from "../options.js";
import type { OpenPageOptions } from "../page.js";

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
type Environment = Record<string, string | undefined>;

export type CliOptions = {
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

export function createRunOptions(
  options: CliOptions,
  context: {
    env?: Environment;
    moduleExtension?: VitexecModuleExtension;
  } = {}
): AppRunOptions & OpenPageOptions {
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

export function addOptions(command: Command, scope: "open" | "run" | "once"): Command {
  if (scope !== "run") {
    command
      .option("--browser-arg <arg>", "extra Chromium launch argument; repeat as needed", collectBrowserArg, [])
      .option("--browser-expose-network <rules>", "network rules exposed to a remote browser")
      .option("--browser-ws-endpoint <url>", "remote Playwright browser endpoint")
      .option("--config <path>", "Vite config file")
      .option("--gpu", "enable GPU-friendly Chromium flags")
      .option("--network-trace <path>", "write a HAR when the app closes")
      .option("--path <path>", "Vite page path")
      .option("--touch", "emulate touch input")
      .option("--viewport <WIDTHxHEIGHT>", "viewport size (default 1280x720)");
  }
  if (scope !== "open") {
    command
      .option("--cpu-profile <path>", "write a CPU profile")
      .option("--heap-snapshot <path>", "write a heap summary")
      .option("--performance-trace <path>", "write a Chrome performance trace")
      .option("--record <path>", "write an MP4 recording")
      .option("--record-audio", "include audio in recordings (default)")
      .option("--no-record-audio", "omit audio from recordings")
      .option("--record-fps <fps>", "recording frame rate", parseRecordFps)
      .option("--screenshot <path>", "write a screenshot after execution");
  }
  return command.option("--timeout <seconds>", "navigation or execution timeout", parseTimeoutSeconds);
}
