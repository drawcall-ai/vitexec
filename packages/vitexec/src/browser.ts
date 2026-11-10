import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import spawn, { SubprocessError } from "nano-spawn";
import type { Browser } from "playwright";
import { withCleanup } from "./errors.js";
import { validateRunOptions, VITEXEC_TIMEOUT_MS } from "./options.js";

export type OpenBrowserOptions = {
  /** Hide the browser window. Defaults to true. */
  headless?: boolean;
  browserArgs?: string[];
  browserExposeNetwork?: string;
  browserWsEndpoint?: string;
  /** Enable GPU hardware acceleration. Defaults to true; false disables it. */
  gpu?: boolean;
  /** Enable page audio, including audio recordings. Defaults to true. */
  audio?: boolean;
  /** Play page audio through the host speakers. Defaults to false; recording is unaffected. */
  audioOutput?: boolean;
  /** Maximum browser launch or connection time in milliseconds. */
  timeoutMs?: number;
  /** Let Playwright handle process signals. Disable when the caller owns shutdown. */
  handleSignals?: boolean;
  log?: (line: string) => void;
};

export const VITEXEC_DEFAULT_REMOTE_EXPOSE_NETWORK = "<loopback>";
export const VITEXEC_LOCAL_GPU_BROWSER_ARGS = [
  "--enable-gpu",
  "--ignore-gpu-blocklist",
  "--enable-unsafe-webgpu"
] as const;
export const VITEXEC_REMOTE_GPU_BROWSER_ARGS = [
  ...VITEXEC_LOCAL_GPU_BROWSER_ARGS
] as const;

/** Create or connect to Chromium. The caller closes the returned browser. */
export async function openBrowser(options: OpenBrowserOptions = {}): Promise<Browser> {
  validateRunOptions(options);
  const { chromium } = await import("playwright");
  const timeout = options.timeoutMs ?? VITEXEC_TIMEOUT_MS;
  const args = createBrowserArgs(options);
  const launchOptions = {
    headless: options.headless ?? true,
    args,
    timeout,
    handleSIGINT: options.handleSignals,
    handleSIGTERM: options.handleSignals,
    handleSIGHUP: options.handleSignals,
    ...(options.audio !== false ? { ignoreDefaultArgs: ["--mute-audio"] } : {})
  };
  if (options.browserWsEndpoint) {
    return chromium.connect(options.browserWsEndpoint, {
      timeout,
      exposeNetwork: options.browserExposeNetwork ?? VITEXEC_DEFAULT_REMOTE_EXPOSE_NETWORK,
      headers: { "x-playwright-launch-options": JSON.stringify(launchOptions) }
    });
  }
  await ensureChromiumInstalled({ log: options.log });
  if (process.platform !== "darwin") return chromium.launch({ channel: "chromium", ...launchOptions });
  // macOS Chromium starts crashpad handlers in their own session, out of reach of Playwright's
  // process-group kill. A hung browser's handlers keep its stderr pipe open, so browser.close()
  // and the caller's process never finish. A per-launch database lets us kill exactly these.
  // Crashpad reports the database by its real path (/private/var, not /var).
  const crashpad = await realpath(await mkdtemp(join(tmpdir(), "vitexec-crashpad-")));
  try {
    const browser = await chromium.launch({
      channel: "chromium",
      ...launchOptions,
      env: { ...process.env, BREAKPAD_DUMP_LOCATION: crashpad }
    });
    // Playwright waits for the handlers' exit before close() resolves, so start killing them on
    // disconnect; close() then reports the cleanup result.
    let cleanup = Promise.resolve();
    browser.on("disconnected", () => {
      cleanup = killCrashpad(crashpad);
      cleanup.catch(() => {});
    });
    const close = browser.close.bind(browser);
    browser.close = options => withCleanup(() => close(options), () => cleanup, "Browser close and crashpad cleanup failed.");
    return browser;
  } catch (error) {
    // A launch can fail after Chromium already started its handlers.
    try { await killCrashpad(crashpad); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Browser launch and crashpad cleanup failed.");
    }
    throw error;
  }
}

async function killCrashpad(database: string): Promise<void> {
  try {
    const pattern = `--database=${database}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await spawn("pkill", ["-KILL", "-f", "--", pattern]);
  } catch (error) {
    // pkill exits with 1 when the handlers already exited with the browser.
    if (!(error instanceof SubprocessError) || error.exitCode !== 1) throw error;
  }
  await rm(database, { recursive: true, force: true });
}

export function createRemoteBrowserHeaders(
  options: Pick<OpenBrowserOptions, "browserArgs" | "gpu" | "audioOutput"> & { recordAudio?: boolean; recordPath?: string }
): Record<string, string> {
  const args = createBrowserArgs(options);

  return {
    "x-playwright-launch-options": JSON.stringify({
      args,
      ...(options.audioOutput || recordsAudio(options) ? { ignoreDefaultArgs: ["--mute-audio"] } : {})
    })
  };
}

function recordsAudio(options: { recordAudio?: boolean; recordPath?: string }): boolean {
  return Boolean(options.recordPath) && options.recordAudio !== false;
}

export function createBrowserArgs(
  options: Pick<OpenBrowserOptions, "browserArgs" | "gpu" | "audioOutput">
): string[] {
  return [
    ...(options.gpu === false ? ["--disable-gpu"] : VITEXEC_LOCAL_GPU_BROWSER_ARGS),
    ...(options.audioOutput === true ? [] : ["--disable-audio-output"]),
    ...(options.browserArgs ?? [])
  ];
}

type EnsureChromiumInstalledOptions = {
  executablePath?: () => string;
  fileExists?: (path: string) => Promise<boolean>;
  install?: () => Promise<void>;
  log?: (line: string) => void;
};

export async function ensureChromiumInstalled(
  options: EnsureChromiumInstalledOptions = {}
): Promise<void> {
  const { chromium } = await import("playwright");
  const executablePath = options.executablePath ?? (() => chromium.executablePath());
  const fileExists = options.fileExists ?? pathExists;
  const install = options.install ?? installPlaywrightChromium;

  if (await fileExists(executablePath())) return;

  options.log?.("[playwright] installing Chromium browser...");
  await install();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return false;
    throw error;
  }
}

async function installPlaywrightChromium(): Promise<void> {
  try {
    await spawn("playwright", ["install", "chromium"], {
      cwd: packageRoot(),
      preferLocal: true,
      stdin: "ignore"
    });
  } catch (error) {
    const details = outputFromSubprocessError(error);
    const suffix = details ? `\n${details}` : "";
    throw new Error(`Playwright failed to install Chromium.${suffix}`);
  }
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function outputFromSubprocessError(error: unknown): string {
  if (typeof error !== "object" || error === null || !("output" in error)) return "";

  const output = error.output;
  return typeof output === "string" ? output.trim() : "";
}

