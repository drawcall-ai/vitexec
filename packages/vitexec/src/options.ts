import { extname } from "node:path";
import type { ViewportSize } from "playwright";
import type { VitexecModuleExtension } from "./index.js";

export const VITEXEC_TIMEOUT_MS = 10 * 60 * 1000;

export type PageRunOptions = {
  /** Receive each log line as it arrives. Logs are discarded when omitted. */
  onLog?: (line: string) => void;
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

export function parseViewport(value: string | undefined): ViewportSize | null {
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

