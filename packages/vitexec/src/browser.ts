import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "nano-spawn";
import type { Browser } from "playwright";
import { hasCode } from "./errors.js";
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
  // Playwright does not expose the launched process, so tag it to find it again in killBrowser().
  const marker = `--vitexec-browser=${randomUUID()}`;
  const browser = await chromium.launch({ channel: "chromium", ...launchOptions, args: [...args, marker] });
  launchMarkers.set(browser, marker);
  return browser;
}

const launchMarkers = new WeakMap<Browser, string>();

/**
 * SIGKILL the process group of a browser launched by openBrowser(), for when browser.close() hangs.
 * Connected remote browsers and Windows are left alone.
 */
export function killBrowser(browser: Browser): void {
  const marker = launchMarkers.get(browser);
  if (!marker || process.platform === "win32") return;
  const line = execFileSync("ps", ["-A", "-ww", "-o", "pid=,args="], { encoding: "utf8" })
    .split("\n").find(line => line.includes(marker));
  if (!line) return;
  // Playwright launches the browser detached, as the leader of its own process group.
  try { process.kill(-Number.parseInt(line, 10), "SIGKILL"); } catch (error) {
    if (!hasCode(error, "ESRCH")) throw error;
  }
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
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return false;
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

