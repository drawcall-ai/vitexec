import type { Page, Browser, BrowserContext } from "playwright";
import { openServer } from "./app.js";
import { openBrowser, type OpenBrowserOptions } from "./browser.js";
import { validateRunOptions, parseViewport, VITEXEC_TIMEOUT_MS, type AppRunOptions } from "./options.js";
import { ensureParentDir } from "./files.js";
import { preparePage } from "./run.js";
import { BROWSER_SHUTDOWN_TIMEOUT_MS, SHUTDOWN_TIMEOUT_MS, within } from "./timeout.js";

export type OpenPageOptions = Pick<AppRunOptions, "root" | "configFile" | "path" | "viewport" | "touch" | "networkTracePath" | "timeoutMs" | "onLog"> & Omit<OpenBrowserOptions, "log" | "handleSignals"> & { signal?: AbortSignal };

/** Open an owned app. Awaiting page.close() also closes its browser and Vite server. */
export async function openPage(options: OpenPageOptions = {}): Promise<Page> {
  validateRunOptions(options);
  options.signal?.throwIfAborted();
  const server = await openServer(options);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    for (const [name, dispose, timeout] of [
      ["Browser context", () => context?.close(), SHUTDOWN_TIMEOUT_MS],
      ["Browser", () => browser?.close(), BROWSER_SHUTDOWN_TIMEOUT_MS],
      ["Vite server", () => server.close(), SHUTDOWN_TIMEOUT_MS]
    ] as const) {
      try {
        await within(Promise.resolve(dispose()), timeout, `${name} shutdown timed out after ${timeout}ms.`);
      } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Failed to close the app.");
    if (context && options.networkTracePath) options.onLog?.(`[network-trace] ${options.networkTracePath}`);
  })();
  try {
    options.signal?.throwIfAborted();
    browser = await openBrowser({ ...options, handleSignals: false, log: options.onLog });
    options.signal?.throwIfAborted();
    if (options.networkTracePath) await ensureParentDir(options.networkTracePath);
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: parseViewport(options.viewport) ?? { width: 1280, height: 720 },
      hasTouch: options.touch,
      ...(options.networkTracePath ? { recordHar: { path: options.networkTracePath } } : {})
    });
    const page = await context.newPage();
    // Bindings must exist before callers can race execution against page shutdown.
    const timeout = options.timeoutMs ?? VITEXEC_TIMEOUT_MS;
    const { collector } = await within(preparePage(page), timeout, `Vitexec page preparation timed out after ${timeout}ms.`);
    collector.setPageLog(options.onLog ?? (() => {}));
    page.close = close;
    options.signal?.throwIfAborted();
    let abort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(options.signal?.reason);
      options.signal?.addEventListener("abort", abort, { once: true });
    });
    try {
      const navigation = (async () => {
        const url = new URL(options.path?.replace(/^\//, "") ?? "", server.url).href;
        const response = await page.goto(url, { waitUntil: "load", timeout: options.timeoutMs ?? VITEXEC_TIMEOUT_MS });
        if (response && !response.ok()) throw new Error(`Page returned HTTP ${response.status()}: ${url}`);
        if (!await page.evaluate(() => document.querySelector('meta[name="vitexec"]')?.getAttribute("content"))) {
          throw new Error(`Page does not support Vitexec injection: ${url}`);
        }
        await collector.drain();
        options.signal?.throwIfAborted();
        return page;
      })();
      return await within(Promise.race([navigation, aborted]), timeout, `Vitexec navigation timed out after ${timeout}ms.`);
    } finally { options.signal?.removeEventListener("abort", abort); }
  } catch (error) {
    try { await close(); } catch (shutdownError) {
      throw new AggregateError([error, shutdownError], "Vitexec startup and shutdown failed.");
    }
    throw error;
  }
}
