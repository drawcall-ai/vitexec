import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { capture, saveScreenshot } from "./artifacts.js";
import { registerScript } from "./injection.js";
import { installInput } from "./input/playwright.js";
import { logs } from "./logs.js";
import { withCleanup } from "./errors.js";
import { CLEANUP_GRACE_MS, within } from "./timeout.js";
export { validateRunOptions, VITEXEC_TIMEOUT_MS } from "./options.js";
export type { PageRunOptions, AppRunOptions } from "./options.js";
import { validateRunOptions, VITEXEC_TIMEOUT_MS, type PageRunOptions } from "./options.js";

const pages = new WeakMap<Page, Promise<Awaited<ReturnType<typeof prepare>>>>();
export function preparePage(page: Page) {
  let pending = pages.get(page);
  if (!pending) { pending = prepare(page); pages.set(page, pending); }
  return pending;
}

async function prepare(page: Page) {
  const collector = await logs(page);
  const active = new Set<string>();
  let driver: string | undefined;
  let profiling = false;
  let uncertain = false;
  const input = await installInput(page, stack => {
    const id = collector.owner(stack ?? "");
    if (!id || !active.has(id)) throw new Error("Input must originate from an active Vitexec script.");
    if (driver && driver !== id) throw new Error("Another Vitexec run owns this page's input.");
    driver = id;
  });
  return {
    collector,
    start(id: string, captures: boolean) {
      if (uncertain) throw new Error("A previous run timed out or failed to clean up; close and reopen the page before running more code.");
      if (captures && profiling) throw new Error("Another Vitexec run is recording or profiling this page.");
      if (captures) profiling = true;
      active.add(id);
    },
    timeout() { uncertain = true; },
    unlock(captures: boolean) { if (captures) profiling = false; },
    async finish(id: string) {
      active.delete(id);
      if (driver !== id) return;
      try { await input.release(); } finally { driver = undefined; }
    }
  };
}

/** Inject into the current document. Never navigates or closes the supplied page. */
export async function run(page: Page, code: string, options: PageRunOptions = {}): Promise<void> {
  validateRunOptions(options);
  const timeout = options.timeoutMs ?? VITEXEC_TIMEOUT_MS;
  const deadline = Date.now() + timeout;
  const state = await within(preparePage(page), timeout, `Vitexec page preparation timed out after ${timeout}ms.`);
  const id = randomUUID();
  const exclusive = Boolean(options.recordPath || options.cpuProfilePath || options.performanceTracePath || options.heapSnapshotPath);
  state.start(id, exclusive);
  let reject: (error: Error) => void = () => {};
  const interrupted = new Promise<never>((_, fail) => { reject = fail; });
  const log = options.onLog ?? (() => {});
  const timer = setTimeout(() => {
    state.timeout();
    reject(new Error(`Vitexec timed out after ${timeout}ms. Code may still be running; close and reopen the page.`));
  }, Math.max(0, deadline - Date.now()));
  let script: Awaited<ReturnType<typeof registerScript>> | undefined;
  let captures: Awaited<ReturnType<typeof capture>> | undefined;
  let starting: Promise<Awaited<ReturnType<typeof registerScript>>> | undefined;
  let failure: { error: unknown } | undefined;
  let completed = false;
  let ended = false;
  await withCleanup(async () => {
    state.collector.add(id, { log, fail: reject });
    const startup = (async () => {
      const registered = await registerScript(page, id, code, options.moduleExtension);
      script = registered;
      if (!ended && exclusive) captures = await capture(page, options, log);
      return registered;
    })();
    starting = startup;
    const execution = (async () => {
      const registered = await startup;
      if (ended) return;
      await page.evaluate(`import(${JSON.stringify(registered.url)}).then(() => undefined)`);
      await state.collector.drain();
      if (ended) return;
      if (options.screenshotPath) {
        await saveScreenshot(page, options.screenshotPath);
        log(`[screenshot] ${options.screenshotPath}`);
      }
    })();
    try {
      await Promise.race([execution, interrupted]);
      completed = true;
    } catch (error) {
      failure = { error };
      throw error;
    }
  }, async () => {
    ended = true;
    clearTimeout(timer);
    state.collector.remove(id);
    const cleanupTimeout = completed ? Math.max(CLEANUP_GRACE_MS, deadline - Date.now()) : CLEANUP_GRACE_MS;
    try {
      const errors = await within((async () => {
        const errors: unknown[] = [];
        try { await starting; } catch (error) {
          if (!failure || failure.error !== error) errors.push(error);
        }
        const cleanup = await Promise.allSettled([
          state.finish(id),
          captures?.finish(completed),
          script?.dispose()
        ]);
        errors.push(...cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []));
        return errors;
      })(), cleanupTimeout, `Vitexec cleanup timed out after ${cleanupTimeout}ms; captures may be incomplete. Close and reopen the page.`);
      if (errors.length) throw new AggregateError(errors, "Vitexec cleanup failed.");
    } catch (error) {
      state.timeout();
      throw error;
    } finally { state.unlock(exclusive); }
  }, "Vitexec execution and cleanup failed.");
}
