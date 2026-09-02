import { setTimeout as sleep } from "node:timers/promises";
import type { CDPSession, Page } from "playwright";
import * as vite from "vite";
import type { Strict } from "./api.js";
import { createInput } from "./input.js";
import { createObserver } from "./observe.js";

const STRICT_MODULE = "vitexec/strict";
const STRICT_IMPORT = /^[ \t]*import\s+(type\s+)?[^'"]*?from\s+["']vitexec\/strict["'];?[ \t]*$/gm;
const ANY_IMPORT = /^[ \t]*import\s/m;
const EMPTY_EXPORT = /^[ \t]*export\s*\{\s*\};?[ \t]*$/gm;
const AsyncFunction = (async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<unknown>;

/**
 * Turn a strict script into a function of the strict API. The script keeps
 * ordinary top-level-await shape; its only permitted import is the typed
 * `vitexec/strict` surface, which is supplied as parameters instead.
 */
export async function compileStrictScript(
  code: string
): Promise<(api: Strict, console: Console) => Promise<unknown>> {
  const source = code.replace(STRICT_IMPORT, "");
  if (ANY_IMPORT.test(source)) {
    throw new Error(
      `A strict script runs outside the page and may only import from "${STRICT_MODULE}"; ` +
      "read app modules with load() and observe() instead."
    );
  }
  const body = (await stripTypes(source)).replace(EMPTY_EXPORT, "");
  const run = new AsyncFunction("observe", "load", "mouse", "keyboard", "sleep", "console", body);
  return (api, console) =>
    run(api.observe, api.load, api.mouse, api.keyboard, api.sleep, console);
}

async function stripTypes(code: string): Promise<string> {
  const transform = vite.transformWithOxc ?? vite.transformWithEsbuild;
  const result = await transform(code, "strict.ts", { sourcemap: false });
  return result.code;
}

export async function runStrictScript(
  code: string,
  page: Page,
  cdp: CDPSession,
  log: (line: string) => void
): Promise<void> {
  const script = await compileStrictScript(code);
  const observer = await createObserver(cdp);
  const input = createInput(page);
  const console = scriptConsole(log);
  try {
    await script({ ...observer, mouse: input.mouse, keyboard: input.keyboard, sleep }, console);
  } catch (error) {
    log(`[error] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  } finally {
    await input.release();
  }
}

function scriptConsole(log: (line: string) => void): Console {
  const line = (type: string) => (...values: unknown[]) =>
    log(`[${type}] ${values.map(formatValue).join(" ")}`);
  return Object.assign(Object.create(globalThis.console) as Console, {
    debug: line("debug"),
    error: line("error"),
    info: line("info"),
    log: line("log"),
    warn: line("warning")
  });
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return JSON.stringify(value) ?? String(value);
}
