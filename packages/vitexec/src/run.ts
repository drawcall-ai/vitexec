import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { capture, saveScreenshot } from "./artifacts.js";
import { registerScript } from "./injection.js";
import { installInput } from "./input/playwright.js";
import { logs } from "./logs.js";
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
    invalidate() { uncertain = true; },
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
    state.invalidate();
    reject(new Error(`Vitexec timed out after ${timeout}ms. Code may still be running; close and reopen the page.`));
  }, Math.max(0, deadline - Date.now()));
  const errors: unknown[] = [];
  let script: Awaited<ReturnType<typeof registerScript>> | undefined;
  let captures: Awaited<ReturnType<typeof capture>> | undefined;
  let ended = false;
  let terminate: (error: Error) => void = () => {};
  const terminal = new Promise<Error>(resolve => { terminate = resolve; });
  const onClose = () => terminate(new Error("Page closed; capture cleanup interrupted."));
  const onCrash = () => terminate(new Error("Page crashed; capture cleanup interrupted."));
  page.once("close", onClose);
  page.once("crash", onCrash);
  if (page.isClosed()) onClose();

  const startup = (async () => {
    state.collector.add(id, { log, fail: reject });
    const registered = await registerScript(page, id, code, options.moduleExtension);
    script = registered;
    if (!ended && exclusive) captures = await capture(page, options, log);
    return registered;
  })();

  async function cleanup(save: boolean) {
    try { await startup; } catch (error) {
      if (!errors.includes(error)) errors.push(error);
    }
    const results = await Promise.allSettled([
      state.finish(id),
      captures?.finish(save),
      script?.dispose()
    ]);
    errors.push(...results.flatMap(result => result.status === "rejected" ? [result.reason] : []));
  }

  try {
    const execution = startup.then(async registered => {
      if (ended) return;
      await page.evaluate(`import(${JSON.stringify(registered.url)}).then(() => undefined)`);
      await state.collector.drain();
      if (ended || !options.screenshotPath) return;
      await saveScreenshot(page, options.screenshotPath);
      log(`[screenshot] ${options.screenshotPath}`);
    });
    try { await Promise.race([execution, interrupted]); }
    catch (error) { errors.push(error); }
    ended = true;
    clearTimeout(timer);
    state.collector.remove(id);

    const failures = errors.length;
    const save = failures === 0;
    const cleanupTimeout = save ? Math.max(CLEANUP_GRACE_MS, deadline - Date.now()) : CLEANUP_GRACE_MS;
    try {
      await within(Promise.race([
        cleanup(save),
        terminal.then(error => { throw error; })
      ]), cleanupTimeout, `Vitexec cleanup timed out after ${cleanupTimeout}ms; captures may be incomplete. Close and reopen the page.`);
    } catch (error) { errors.push(error); }
    if (errors.length > failures) state.invalidate();
    if (errors.length > 1) throw new AggregateError(errors, "Vitexec execution or cleanup failed.");
    if (errors.length) throw errors[0];
  } finally {
    state.unlock(exclusive);
    page.off("close", onClose);
    page.off("crash", onCrash);
  }
}
