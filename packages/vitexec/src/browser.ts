import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "nano-spawn";
import type { Browser } from "playwright";

export type CreateBrowserOptions = {
  browserArgs?: string[];
  browserExposeNetwork?: string;
  browserWsEndpoint?: string;
  /** Enable GPU-friendly Chromium flags. Defaults to true. */
  gpu?: boolean;
  /** Enable page audio, including audio recordings. Defaults to true. */
  audio?: boolean;
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
export async function createBrowser(options: CreateBrowserOptions = {}): Promise<Browser> {
  const { chromium } = await import("playwright");
  const args = createBrowserArgs({ ...options, gpu: options.gpu ?? true });
  const launchOptions = {
    args,
    ...(options.audio !== false ? { ignoreDefaultArgs: ["--mute-audio"] } : {})
  };
  if (options.browserWsEndpoint) {
    return chromium.connect(options.browserWsEndpoint, {
      exposeNetwork: options.browserExposeNetwork ?? VITEXEC_DEFAULT_REMOTE_EXPOSE_NETWORK,
      headers: { "x-playwright-launch-options": JSON.stringify(launchOptions) }
    });
  }
  await ensureChromiumInstalled({ log: options.log });
  return chromium.launch({ channel: "chromium", ...launchOptions });
}

export function createRemoteBrowserHeaders(
  options: Pick<CreateBrowserOptions, "browserArgs" | "gpu"> & { recordAudio?: boolean; recordPath?: string }
): Record<string, string> | undefined {
  const args = createBrowserArgs(options);
  if (!args && !recordsAudio(options)) return undefined;

  return {
    "x-playwright-launch-options": JSON.stringify({
      ...(args ? { args } : {}),
      ...(recordsAudio(options) ? { ignoreDefaultArgs: ["--mute-audio"] } : {})
    })
  };
}

function recordsAudio(options: { recordAudio?: boolean; recordPath?: string }): boolean {
  return Boolean(options.recordPath) && options.recordAudio !== false;
}

export function createBrowserArgs(
  options: Pick<CreateBrowserOptions, "browserArgs" | "gpu">
): string[] | undefined {
  const args = [
    ...(options.gpu ? VITEXEC_LOCAL_GPU_BROWSER_ARGS : []),
    ...(options.browserArgs ?? [])
  ];

  return args.length > 0 ? args : undefined;
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

