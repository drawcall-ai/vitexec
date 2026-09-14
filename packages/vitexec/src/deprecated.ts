import { Readable } from "node:stream";
import type { Page } from "playwright";
import { openPage, type OpenPageOptions } from "./page.js";
import { run, type PageRunOptions } from "./run.js";

export type RunVitexecOptions = Omit<OpenPageOptions & PageRunOptions, "onLog" | "signal">;

/** @deprecated Use openPage(), run(page, code), and page.close(). */
export async function* runVitexec(code: string, options: RunVitexecOptions = {}): AsyncGenerator<string> {
  const abort = new AbortController();
  const lines = new Readable({ objectMode: true, read() {} });
  const onLog = (line: string) => { if (!lines.destroyed) lines.push(line); };
  let page: Page | undefined;
  const task = (async () => {
    try {
      page = await openPage({ ...options, onLog, signal: abort.signal });
      await run(page, code, { ...options, onLog });
    } catch (error) {
      // Ending iteration cancels startup or closes the running page.
      if (!abort.signal.aborted || (!page && error !== abort.signal.reason)) throw error;
    } finally { await page?.close(); }
  })();
  void task.then(
    () => lines.push(null),
    error => lines.destroy(error instanceof Error ? error : new Error(String(error)))
  );
  try {
    for await (const line of lines) {
      if (typeof line !== "string") throw new Error("Invalid Vitexec log entry.");
      yield line;
    }
  } finally {
    abort.abort();
    lines.destroy();
    try { await page?.close(); } finally { await task; }
  }
}
