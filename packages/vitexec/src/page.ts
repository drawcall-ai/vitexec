import type { Page, Browser, BrowserContext } from "playwright";
import { openServer } from "./app.js";
import { openBrowser, type OpenBrowserOptions } from "./browser.js";
import { validateRunOptions, parseViewport, VITEXEC_TIMEOUT_MS, type AppRunOptions } from "./options.js";
import { ensureParentDir } from "./files.js";
import { preparePage } from "./run.js";

export type OpenPageOptions = Pick<AppRunOptions, "root" | "configFile" | "path" | "viewport" | "touch" | "networkTracePath" | "timeoutMs" | "onLog"> & Omit<OpenBrowserOptions, "log" | "handleSignals">;

/** Open an owned app. Awaiting page.close() also closes its browser and Vite server. */
export async function openPage(options: OpenPageOptions = {}): Promise<Page> {
  validateRunOptions(options);
  const server = await openServer(options);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    for (const dispose of [() => context?.close(), () => browser?.close(), () => server.close()]) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Failed to close the app.");
  })();
  try {
    browser = await openBrowser({ ...options, handleSignals: false, log: options.onLog });
    if (options.networkTracePath) await ensureParentDir(options.networkTracePath);
    context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: parseViewport(options.viewport) ?? { width: 1280, height: 720 },
      hasTouch: options.touch,
      ...(options.networkTracePath ? { recordHar: { path: options.networkTracePath } } : {})
    });
    const page = await context.newPage();
    // Bindings must exist before callers can race execution against page shutdown.
    const { collector } = await preparePage(page);
    collector.setPageLog(options.onLog ?? (() => {}));
    page.close = close;
    const url = new URL(options.path?.replace(/^\//, "") ?? "", server.url).href;
    const response = await page.goto(url, { waitUntil: "load", timeout: options.timeoutMs ?? VITEXEC_TIMEOUT_MS });
    if (response && !response.ok()) throw new Error(`Page returned HTTP ${response.status()}: ${url}`);
    if (!await page.evaluate(() => document.querySelector('meta[name="vitexec"]')?.getAttribute("content"))) {
      throw new Error(`Page does not support Vitexec injection: ${url}`);
    }
    await collector.drain();
    return page;
  } catch (error) {
    await close();
    throw error;
  }
}
