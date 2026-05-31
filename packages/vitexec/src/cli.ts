#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import spawn from "nano-spawn";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type ConsoleMessage,
  type Frame,
  type Page,
  type Request,
  type Response
} from "playwright";
import { createServer, loadConfigFromFile, type ViteDevServer } from "vite";
import { vitexec, type VitexecModuleExtension } from "./index.js";

declare global {
  var __vitexecRuns: Record<string, Promise<unknown> | undefined>;
}

export const VITEXEC_TIMEOUT_MS = 10 * 60 * 1000;
export const VITEXEC_DEFAULT_REMOTE_EXPOSE_NETWORK = "<loopback>";
export const VITEXEC_ENV = {
  browserExposeNetwork: "VITEXEC_BROWSER_EXPOSE_NETWORK",
  browserWsEndpoint: "VITEXEC_BROWSER_WS_ENDPOINT",
  config: "VITEXEC_CONFIG",
  cpuProfile: "VITEXEC_CPU_PROFILE",
  gpu: "VITEXEC_GPU",
  heapSnapshot: "VITEXEC_HEAP_SNAPSHOT",
  networkTrace: "VITEXEC_NETWORK_TRACE",
  path: "VITEXEC_PATH",
  performanceTrace: "VITEXEC_PERFORMANCE_TRACE",
  record: "VITEXEC_RECORD",
  screenshot: "VITEXEC_SCREENSHOT",
  timeout: "VITEXEC_TIMEOUT",
  keepBrowserOpen: "VITEXEC_KEEP_BROWSER_OPEN"
} as const;
export const VITEXEC_LOCAL_GPU_BROWSER_ARGS = [
  "--enable-gpu",
  "--ignore-gpu-blocklist",
  "--enable-unsafe-webgpu"
] as const;
export const VITEXEC_REMOTE_GPU_BROWSER_ARGS = [
  ...VITEXEC_LOCAL_GPU_BROWSER_ARGS
] as const;

export type RunVitexecOptions = {
  browserExposeNetwork?: string;
  browserWsEndpoint?: string;
  configFile?: string | false;
  cpuProfilePath?: string;
  gpu?: boolean;
  heapSnapshotPath?: string;
  moduleExtension?: VitexecModuleExtension;
  networkTracePath?: string;
  path?: string;
  performanceTracePath?: string;
  recordPath?: string;
  root?: string;
  screenshotPath?: string;
  timeoutMs?: number;
  /**
   * Adopt an already-open Playwright Page instead of launching/connecting a
   * browser. The thunk is invoked AFTER vitexec's Vite server is listening, so
   * a caller (e.g. a Vite plugin that launches a browser on `listening`) can
   * hand over the page it just opened. vitexec navigates that page to its own
   * per-run URL, runs the snippet, and never closes the page/context/browser.
   * Same-process only — a Page is a live RPC proxy bound to its owning process.
   */
  adoptPage?: () => Page | Promise<Page>;
  /** Adopt an already-open Page directly (same constraints as `adoptPage`). */
  page?: Page;
  /** Adopt a context (vitexec opens a fresh page in it) instead of newContext. */
  context?: BrowserContext;
  /** Adopt a browser (vitexec opens a fresh context+page) instead of launch/connect. */
  browser?: Browser;
  /**
   * Never close the browser/context/page on finish or abort. Implied true when
   * a page/context/browser is adopted; also settable on the `browserWsEndpoint`
   * path to leave a `launchServer` browser running between runs. vitexec always
   * still closes its own Vite server.
   */
  keepBrowserOpen?: boolean;
};

// One stable `__vitexecReport` binding per page, dispatching to the current
// run's resolver. Lets a single adopted page be reused across sequential runs
// without Playwright's "function already registered" error.
const VITEXEC_BOUND_PAGES = new WeakSet<Page>();
const VITEXEC_REPORT_RESOLVERS = new WeakMap<Page, () => void>();

async function ensureReportBinding(page: Page): Promise<void> {
  if (VITEXEC_BOUND_PAGES.has(page)) return;
  VITEXEC_BOUND_PAGES.add(page);
  try {
    await page.exposeFunction("__vitexecReport", () => {
      VITEXEC_REPORT_RESOLVERS.get(page)?.();
    });
  } catch {
    // Already exposed on a reused page (e.g. survived a prior run). The resolver
    // indirection means the existing binding routes to the current run — safe.
  }
}

/**
 * Convenience wrapper: run a snippet inside an already-open Playwright Page
 * (e.g. a dev server's visible managed tab) without launching a second browser.
 */
export function runVitexecOnPage(
  code: string,
  page: Page,
  options: Omit<RunVitexecOptions, "page" | "adoptPage"> = {}
): AsyncGenerator<string> {
  return runVitexec(code, { ...options, page, keepBrowserOpen: true });
}

type Environment = Record<string, string | undefined>;

type CliOptions = {
  browserExposeNetwork?: string;
  browserWsEndpoint?: string;
  config?: string;
  cpuProfile?: string;
  gpu?: boolean;
  heapSnapshot?: string;
  networkTrace?: string;
  path?: string;
  performanceTrace?: string;
  record?: string;
  screenshot?: string;
  timeout?: number;
  keepBrowserOpen?: boolean;
};

export async function* runVitexec(
  code: string,
  options: RunVitexecOptions = {}
): AsyncGenerator<string> {
  const id = randomUUID();
  const server = await startViteServer(id, code, options);

  try {
    yield* runVitexecInServer(server, id, options);
  } finally {
    await server.close();
  }
}

export async function resolveVitexecCodeInput(
  codeParts: string[],
  cwd = process.cwd()
): Promise<string> {
  return (await resolveVitexecCodeInputDetails(codeParts, cwd)).code;
}

export type ResolvedVitexecCodeInput = {
  code: string;
  moduleExtension: VitexecModuleExtension;
};

export async function resolveVitexecCodeInputDetails(
  codeParts: string[],
  cwd = process.cwd()
): Promise<ResolvedVitexecCodeInput> {
  if (codeParts.length !== 1) {
    return { code: codeParts.join(" "), moduleExtension: ".js" };
  }

  const input = codeParts[0];
  const filePath = resolve(cwd, input);
  if (!(await isFile(filePath))) return { code: input, moduleExtension: ".js" };

  return {
    code: await readFile(filePath, "utf8"),
    moduleExtension: moduleExtensionFromPath(filePath)
  };
}

function moduleExtensionFromPath(path: string): VitexecModuleExtension {
  const extension = extname(path);
  return isModuleExtension(extension) ? extension : ".js";
}

function isModuleExtension(value: string): value is VitexecModuleExtension {
  return [".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(value);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (isFileMissingError(error)) return false;
    throw error;
  }
}

function isFileMissingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ENOENT" ||
      error.code === "ENOTDIR" ||
      error.code === "ENAMETOOLONG")
  );
}

async function* runVitexecInServer(
  server: ViteDevServer,
  id: string,
  options: RunVitexecOptions
): AsyncGenerator<string> {
  const abort = new AbortController();
  const lines = new Readable({ objectMode: true, read() {} });
  const log = (line: string) => {
    if (!lines.destroyed) lines.push(line);
  };
  const run = runVitexecInServerTask(server, id, options, log, abort.signal).then(
    () => lines.push(null),
    (error) => lines.destroy(error instanceof Error ? error : new Error(String(error)))
  );

  try {
    for await (const line of lines) yield line as string;
    await run;
  } finally {
    abort.abort();
    lines.destroy();
    await run.catch(() => undefined);
  }
}

async function runVitexecInServerTask(
  server: ViteDevServer,
  id: string,
  options: RunVitexecOptions,
  log: (line: string) => void,
  signal: AbortSignal
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? VITEXEC_TIMEOUT_MS;
  const url = buildServerPageUrl(server, options.path);
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let cdp: CDPSession | undefined;
  let performanceTrace: PerformanceTraceCapture | undefined;

  // Ownership: vitexec only closes browser-tree handles it created itself. When a
  // caller adopts an existing page/context/browser (e.g. a dev server handing
  // over its visible managed tab), vitexec reuses it and leaves it open. vitexec
  // always owns and closes its own Vite server (see runVitexec).
  let ownsBrowser = false;
  let ownsContext = false;
  let ownsPage = false;
  let keepOpen = options.keepBrowserOpen ?? false;
  const closeBrowser = () => {
    if (!keepOpen) void browser?.close().catch(() => undefined);
  };

  const pendingConsoleLogs = new Set<Promise<void>>();
  const collectConsoleLog = (message: ConsoleMessage) => {
    const pendingLog = collectConsole(log, message);
    pendingConsoleLogs.add(pendingLog);
    pendingLog.finally(() => pendingConsoleLogs.delete(pendingLog));
  };
  const onPageError = (error: Error) => log(`[page error] ${error.message}`);
  const onRequestFailed = (request: Request) => log(formatRequestFailure(request));
  const onResponse = (response: Response) => {
    if (response.status() >= 400) log(formatHttpError(response));
  };
  let hasMainFrameNavigated = false;
  const onFrameNavigated = (frame: Frame) => {
    if (frame !== page?.mainFrame()) return;
    if (hasMainFrameNavigated) log(`[navigation] navigated ${frame.url()}`);
    hasMainFrameNavigated = true;
  };

  try {
    const adoptedPage =
      options.page ?? (options.adoptPage ? await options.adoptPage() : undefined);

    if (adoptedPage) {
      page = adoptedPage;
      context = page.context();
      browser = context.browser() ?? undefined;
      keepOpen = true;
    } else if (options.context) {
      context = options.context;
      browser = context.browser() ?? undefined;
      keepOpen = true;
      ownsPage = true;
      page = await context.newPage();
    } else if (options.browser) {
      browser = options.browser;
      keepOpen = true;
      ownsContext = true;
      ownsPage = true;
    } else {
      browser = await launchBrowser(options, log);
      ownsBrowser = true;
      ownsContext = true;
      ownsPage = true;
      signal.addEventListener("abort", closeBrowser, { once: true });
    }
    if (signal.aborted) return;

    if (ownsContext) {
      if (options.networkTracePath) await ensureParentDir(options.networkTracePath);
      context = await browser!.newContext({
        ignoreHTTPSErrors: true,
        ...(options.networkTracePath && !signal.aborted
          ? { recordHar: { path: options.networkTracePath } }
          : {}),
        ...(options.recordPath && !signal.aborted
          ? { recordVideo: { dir: dirname(options.recordPath) } }
          : {})
      });
      page = await context.newPage();
    }
    if (!page || !context) {
      throw new Error("vitexec could not acquire a browser page.");
    }
    if (!ownsContext && (options.networkTracePath || options.recordPath)) {
      log("[skipped] --record / --network-trace require a vitexec-created context; ignored for adopted page");
    }

    cdp = await context.newCDPSession(page);
    if (options.cpuProfilePath) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
    }
    if (options.performanceTracePath) {
      performanceTrace = await startPerformanceTrace(cdp);
    }
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    page.on("console", collectConsoleLog);
    page.on("pageerror", onPageError);
    page.on("requestfailed", onRequestFailed);
    page.on("response", onResponse);
    page.on("framenavigated", onFrameNavigated);

    const injectedCodeFinished = createInjectedCodeCompletion(timeoutMs, signal);
    VITEXEC_REPORT_RESOLVERS.set(page, injectedCodeFinished.resolve);
    await ensureReportBinding(page);

    // An adopted page has already loaded once (its pre-existing document). The
    // injected runtime is "armed" (see startViteServer), so arm it now — before
    // our own navigation — so the snippet runs exactly once, on our load, after
    // __vitexecReport is bound. Fresh owned pages are not armed.
    if (adoptedPage) {
      await page.addInitScript((armId) => {
        (globalThis as Record<string, unknown>).__vitexecArm = armId;
      }, id);
    }

    const response = await page.goto(url, {
      timeout: timeoutMs,
      waitUntil: "load"
    });
    if (!response) log("[navigation] no response");
    if (response && !response.ok()) {
      log(`[navigation] ${response.status()} ${response.statusText()} ${response.url()}`);
    }

    await injectedCodeFinished.promise;
    if (options.screenshotPath) {
      await saveScreenshot(page, options.screenshotPath);
      log(`[screenshot] ${options.screenshotPath}`);
    }
  } catch (error) {
    if (signal.aborted) return;
    if (!isTimeoutError(error)) throw error;
    log(`[error] timeout after ${formatDuration(timeoutMs)}: vitexec stopped waiting for the page.`);
  } finally {
    await Promise.allSettled(pendingConsoleLogs);
    try {
      if (cdp && options.cpuProfilePath && !signal.aborted) {
        await saveCpuProfile(cdp, options.cpuProfilePath);
        log(`[cpu-profile] ${options.cpuProfilePath}`);
      }
      if (cdp && performanceTrace && options.performanceTracePath && !signal.aborted) {
        await savePerformanceTrace(cdp, performanceTrace, options.performanceTracePath);
        log(`[performance-trace] ${options.performanceTracePath}`);
      }
      if (cdp && options.heapSnapshotPath && !signal.aborted) {
        await saveHeapSnapshotSummary(cdp, options.heapSnapshotPath);
        log(`[heap-snapshot] ${options.heapSnapshotPath}`);
      }
      if (ownsContext && page && options.recordPath && !signal.aborted) {
        await saveRecording(page, options.recordPath);
        log(`[recording] ${options.recordPath}`);
      }
    } finally {
      signal.removeEventListener("abort", closeBrowser);
      // Detach our own listeners so an adopted (reused) page does not accumulate
      // handlers across runs; the caller's own listeners are untouched.
      if (page) {
        VITEXEC_REPORT_RESOLVERS.delete(page);
        page.off("console", collectConsoleLog);
        page.off("pageerror", onPageError);
        page.off("requestfailed", onRequestFailed);
        page.off("response", onResponse);
        page.off("framenavigated", onFrameNavigated);
      }
      if (cdp) await cdp.detach().catch(() => undefined);
      if (ownsContext && context) {
        await context.close().then(
          () => {
            if (options.networkTracePath && !signal.aborted) {
              log(`[network-trace] ${options.networkTracePath}`);
            }
          },
          () => undefined
        );
      }
      if (ownsBrowser && !keepOpen) await browser?.close().catch(() => undefined);
    }
  }
}

async function startViteServer(
  id: string,
  code: string,
  options: RunVitexecOptions
): Promise<ViteDevServer> {
  const root = await resolveViteRootOption(options);
  // Arm the injected runtime when we will adopt an already-loaded page, so the
  // snippet runs only after vitexec arms+navigates it (not on its prior load).
  const armed = Boolean(options.page || options.adoptPage);
  const server = await createServer({
    configFile: options.configFile,
    root,
    logLevel: "silent",
    server: {
      hmr: false,
      host: "127.0.0.1",
      open: false,
      port: 0,
      strictPort: false,
      watch: null
    },
    plugins: [vitexec({ code, id, moduleExtension: options.moduleExtension, armed })]
  });

  await server.listen();
  return server;
}

async function resolveViteRootOption(options: RunVitexecOptions): Promise<string | undefined> {
  if (options.root || !options.configFile) return options.root;
  const configFile = resolve(options.configFile);
  const configRoot = dirname(configFile);
  const loadedConfig = await loadConfigFromFile(
    { command: "serve", mode: "development", isSsrBuild: false, isPreview: false },
    configFile,
    configRoot,
    "silent"
  );
  if (loadedConfig?.config.root !== undefined) return undefined;

  return configRoot;
}

function buildServerPageUrl(server: ViteDevServer, path?: string): string {
  const base = server.resolvedUrls?.local[0];
  if (base) {
    return path === undefined ? base : new URL(normalizePagePath(path), base).toString();
  }

  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start Vite server.");
  }

  const url = `http://127.0.0.1:${address.port}/`;
  return new URL(path === undefined ? server.config.base : normalizePagePath(path), url).toString();
}

function normalizePagePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

async function launchBrowser(
  options: RunVitexecOptions,
  log: (line: string) => void
): Promise<Browser> {
  if (options.browserWsEndpoint) {
    return chromium.connect(options.browserWsEndpoint, {
      exposeNetwork: options.browserExposeNetwork ?? VITEXEC_DEFAULT_REMOTE_EXPOSE_NETWORK,
      headers: createRemoteBrowserHeaders(options)
    });
  }

  await ensureChromiumInstalled({ log });

  return chromium.launch({
    channel: "chromium",
    args: options.gpu ? [...VITEXEC_LOCAL_GPU_BROWSER_ARGS] : undefined
  });
}

export function createRemoteBrowserHeaders(
  options: Pick<RunVitexecOptions, "gpu">
): Record<string, string> | undefined {
  if (!options.gpu) return undefined;

  return {
    "x-playwright-launch-options": JSON.stringify({
      args: VITEXEC_REMOTE_GPU_BROWSER_ARGS
    })
  };
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
    if (isFileMissingError(error)) return false;
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

async function ensureParentDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

async function saveScreenshot(
  page: Page,
  path: string
): Promise<void> {
  await ensureParentDir(path);
  await page.screenshot({ path, fullPage: true });
}

type PerformanceTraceCapture = {
  events: unknown[];
  complete: Promise<void>;
};

async function startPerformanceTrace(cdp: CDPSession): Promise<PerformanceTraceCapture> {
  const events: unknown[] = [];
  let resolveComplete: (() => void) | undefined;
  const complete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });

  cdp.on("Tracing.dataCollected", (event) => {
    if (isTraceDataCollectedEvent(event)) events.push(...event.value);
  });
  cdp.on("Tracing.tracingComplete", () => resolveComplete?.());

  await cdp.send("Tracing.start", {
    categories: [
      "devtools.timeline",
      "disabled-by-default-devtools.timeline",
      "v8",
      "blink.user_timing",
      "loading",
      "toplevel",
      "cc",
      "gpu"
    ].join(",")
  });

  return { events, complete };
}

function isTraceDataCollectedEvent(value: unknown): value is { value: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    Array.isArray(value.value)
  );
}

async function saveCpuProfile(cdp: CDPSession, path: string): Promise<void> {
  const result = await cdp.send("Profiler.stop");
  await writeJson(path, result.profile);
}

async function savePerformanceTrace(
  cdp: CDPSession,
  trace: PerformanceTraceCapture,
  path: string
): Promise<void> {
  await cdp.send("Tracing.end");
  await trace.complete;
  await writeJson(path, { traceEvents: trace.events });
}

type DecodedHeapSnapshot = {
  schemaVersion: 1;
  nodes: DecodedHeapNode[];
  edges: DecodedHeapEdge[];
  summary: HeapSnapshotSummary;
};

type DecodedHeapNode = {
  index: number;
  ordinal: number;
  id?: number;
  type: string;
  name: string;
  selfSize: number;
  edgeCount: number;
  traceNodeId?: number;
};

type DecodedHeapEdge = {
  index: number;
  fromNodeIndex: number;
  fromNodeOrdinal: number;
  toNodeIndex: number;
  toNodeOrdinal: number;
  type: string;
  name: string;
};

type HeapSnapshotSummary = {
  topConstructorsByCount: HeapConstructorSummary[];
  topConstructorsBySelfSize: HeapConstructorSummary[];
  detachedDomNodeCount: number;
  largeStrings: HeapNodeSummary[];
  largeArrays: HeapNodeSummary[];
  largeArrayBuffers: HeapNodeSummary[];
};

type HeapConstructorSummary = {
  type: string;
  name: string;
  count: number;
  selfSize: number;
};

type HeapNodeSummary = {
  type: string;
  name: string;
  selfSize: number;
};

async function saveHeapSnapshotSummary(cdp: CDPSession, path: string): Promise<void> {
  const chunks: string[] = [];
  const collectChunk = (event: unknown) => {
    if (isHeapSnapshotChunkEvent(event)) chunks.push(event.chunk);
  };

  cdp.on("HeapProfiler.addHeapSnapshotChunk", collectChunk);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", collectChunk);
  }

  await writeJson(path, summarizeHeapSnapshot(JSON.parse(chunks.join(""))));
}

function isHeapSnapshotChunkEvent(value: unknown): value is { chunk: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "chunk" in value &&
    typeof value.chunk === "string"
  );
}

function summarizeHeapSnapshot(snapshot: unknown): DecodedHeapSnapshot {
  if (!isHeapSnapshot(snapshot)) {
    throw new Error("Chrome returned an unexpected heap snapshot shape.");
  }

  const meta = snapshot.snapshot.meta;
  const nodeFields = meta.node_fields;
  const nodeTypes = meta.node_types;
  const edgeFields = meta.edge_fields;
  const edgeTypes = meta.edge_types;
  const typeIndex = nodeFields.indexOf("type");
  const nameIndex = nodeFields.indexOf("name");
  const idIndex = nodeFields.indexOf("id");
  const selfSizeIndex = nodeFields.indexOf("self_size");
  const edgeCountIndex = nodeFields.indexOf("edge_count");
  const traceNodeIdIndex = nodeFields.indexOf("trace_node_id");
  const edgeTypeIndex = edgeFields.indexOf("type");
  const edgeNameOrIndexIndex = edgeFields.indexOf("name_or_index");
  const edgeToNodeIndex = edgeFields.indexOf("to_node");
  if (
    typeIndex === -1 ||
    nameIndex === -1 ||
    selfSizeIndex === -1 ||
    edgeCountIndex === -1 ||
    edgeTypeIndex === -1 ||
    edgeNameOrIndexIndex === -1 ||
    edgeToNodeIndex === -1
  ) {
    throw new Error("Chrome heap snapshot is missing expected node fields.");
  }

  const nodeFieldCount = nodeFields.length;
  const edgeFieldCount = edgeFields.length;
  const typeNames = nodeTypes[typeIndex] ?? [];
  const edgeTypeNames = edgeTypes[edgeTypeIndex] ?? [];
  const constructors = new Map<string, HeapConstructorSummary>();
  const largeStrings: HeapNodeSummary[] = [];
  const largeArrays: HeapNodeSummary[] = [];
  const largeArrayBuffers: HeapNodeSummary[] = [];
  const nodeOrdinalByIndex = new Map<number, number>();
  const nodes: DecodedHeapNode[] = [];
  const edges: DecodedHeapEdge[] = [];
  let detachedDomNodeCount = 0;
  let ordinal = 0;

  for (let index = 0; index < snapshot.nodes.length; index += nodeFieldCount) {
    const type = typeNames[snapshot.nodes[index + typeIndex]] ?? "unknown";
    const name = snapshot.strings[snapshot.nodes[index + nameIndex]] ?? "";
    const selfSize = snapshot.nodes[index + selfSizeIndex] ?? 0;
    const edgeCount = snapshot.nodes[index + edgeCountIndex] ?? 0;

    const key = `${type}\0${name}`;
    const current = constructors.get(key) ?? { type, name, count: 0, selfSize: 0 };
    current.count += 1;
    current.selfSize += selfSize;
    constructors.set(key, current);

    if (name.includes("Detached")) detachedDomNodeCount += 1;
    const node = { type, name, selfSize };
    if (type === "string" && selfSize > 0) largeStrings.push(node);
    if (name === "Array" && selfSize > 0) largeArrays.push(node);
    if (name === "ArrayBuffer" && selfSize > 0) largeArrayBuffers.push(node);

    const decodedNode: DecodedHeapNode = {
      index,
      ordinal,
      type,
      name,
      selfSize,
      edgeCount
    };
    if (idIndex !== -1) decodedNode.id = snapshot.nodes[index + idIndex];
    if (traceNodeIdIndex !== -1) {
      decodedNode.traceNodeId = snapshot.nodes[index + traceNodeIdIndex];
    }
    nodeOrdinalByIndex.set(index, ordinal);
    nodes.push(decodedNode);
    ordinal += 1;
  }

  let edgeIndex = 0;
  let nodeIndex = 0;
  for (const node of nodes) {
    for (let edgeOffset = 0; edgeOffset < node.edgeCount; edgeOffset += 1) {
      const edgeType = edgeTypeNames[snapshot.edges[edgeIndex + edgeTypeIndex]] ?? "unknown";
      const nameOrIndex = snapshot.edges[edgeIndex + edgeNameOrIndexIndex] ?? 0;
      const toNodeIndex = snapshot.edges[edgeIndex + edgeToNodeIndex] ?? 0;
      edges.push({
        index: edgeIndex,
        fromNodeIndex: nodeIndex,
        fromNodeOrdinal: node.ordinal,
        toNodeIndex,
        toNodeOrdinal: nodeOrdinalByIndex.get(toNodeIndex) ?? -1,
        type: edgeType,
        name: formatHeapEdgeName(edgeType, nameOrIndex, snapshot.strings)
      });
      edgeIndex += edgeFieldCount;
    }
    nodeIndex += nodeFieldCount;
  }

  return {
    schemaVersion: 1,
    nodes,
    edges,
    summary: {
      topConstructorsByCount: sortByCount(constructors.values()).slice(0, 50),
      topConstructorsBySelfSize: sortBySelfSize(constructors.values()).slice(0, 50),
      detachedDomNodeCount,
      largeStrings: sortNodesBySelfSize(largeStrings).slice(0, 50),
      largeArrays: sortNodesBySelfSize(largeArrays).slice(0, 50),
      largeArrayBuffers: sortNodesBySelfSize(largeArrayBuffers).slice(0, 50)
    }
  };
}

type HeapSnapshot = {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: string[][];
      edge_fields: string[];
      edge_types: string[][];
    };
  };
  nodes: number[];
  edges: number[];
  strings: string[];
};

function isHeapSnapshot(value: unknown): value is HeapSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Partial<HeapSnapshot>;
  return (
    typeof snapshot.snapshot === "object" &&
    snapshot.snapshot !== null &&
    typeof snapshot.snapshot.meta === "object" &&
    snapshot.snapshot.meta !== null &&
    Array.isArray(snapshot.snapshot.meta.node_fields) &&
    Array.isArray(snapshot.snapshot.meta.node_types) &&
    Array.isArray(snapshot.snapshot.meta.edge_fields) &&
    Array.isArray(snapshot.snapshot.meta.edge_types) &&
    Array.isArray(snapshot.nodes) &&
    Array.isArray(snapshot.edges) &&
    Array.isArray(snapshot.strings)
  );
}

function formatHeapEdgeName(type: string, nameOrIndex: number, strings: string[]): string {
  if (type === "element" || type === "hidden") return String(nameOrIndex);
  return strings[nameOrIndex] ?? String(nameOrIndex);
}

function sortByCount(values: Iterable<HeapConstructorSummary>): HeapConstructorSummary[] {
  return [...values].sort((a, b) => b.count - a.count || b.selfSize - a.selfSize);
}

function sortBySelfSize(values: Iterable<HeapConstructorSummary>): HeapConstructorSummary[] {
  return [...values].sort((a, b) => b.selfSize - a.selfSize || b.count - a.count);
}

function sortNodesBySelfSize(values: HeapNodeSummary[]): HeapNodeSummary[] {
  return values.sort((a, b) => b.selfSize - a.selfSize);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await ensureParentDir(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createInjectedCodeCompletion(timeoutMs: number, signal: AbortSignal): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;
  const abort = () => rejectCompletion?.(createAbortError());
  const promise = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
    timeout = setTimeout(() => reject(createTimeoutError()), timeoutMs);
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  });
  promise.catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  return {
    promise,
    resolve() {
      resolveCompletion?.();
    }
  };
}

async function saveRecording(
  page: Page,
  path: string
): Promise<void> {
  const video = page.video();
  if (!video) throw new Error("Recording was requested, but Playwright did not create a video.");

  await ensureParentDir(path);
  await page.close();
  await video.saveAs(path);
  await video.delete().catch(() => undefined);
}

async function collectConsole(
  log: (line: string) => void,
  message: ConsoleMessage
): Promise<void> {
  if (isIgnoredBrowserConsoleMessage(message)) return;

  const values = await Promise.all(
    message.args().map(async (argument) => argument.jsonValue().catch(() => argument.toString()))
  );
  const text = values.length ? values.map(formatValue).join(" ") : message.text();
  log(`[${message.type()}] ${text}`);
}

function isBrowserResourceError(message: ConsoleMessage): boolean {
  return (
    message.type() === "error" &&
    message.text().startsWith("Failed to load resource:")
  );
}

function isIgnoredBrowserConsoleMessage(message: ConsoleMessage): boolean {
  return isBrowserResourceError(message) || isViteClientDebugMessage(message);
}

function isViteClientDebugMessage(message: ConsoleMessage): boolean {
  return message.type() === "debug" && message.text().startsWith("[vite] ");
}

function formatHttpError(response: Response): string {
  const request = response.request();
  return `[http ${response.status()}] ${request.method()} ${response.url()} ${response.statusText()}`;
}

function formatRequestFailure(request: Request): string {
  return `[request failed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "unknown error"}`;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function createTimeoutError(): Error {
  const error = new Error("Timed out waiting for injected code.");
  error.name = "TimeoutError";
  return error;
}

function createAbortError(): Error {
  const error = new Error("Vitexec run aborted.");
  error.name = "AbortError";
  return error;
}

function formatDuration(ms: number): string {
  return ms === VITEXEC_TIMEOUT_MS ? "10m" : `${ms}ms`;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function main(): Promise<void> {
  const program = new Command()
    .name("vitexec")
    .description("Run a snippet inside a Vite app and print browser logs.")
    .argument("<code-or-file...>", "literal snippet to run, or a path to a snippet file")
    .option(
      "--browser-expose-network <rules>",
      "network rules exposed from this machine to a remote Playwright browser"
    )
    .option("--config <path>", "use a specific Vite config file")
    .option("--cpu-profile <path>", "write a Chrome/V8 CPU profile after the code runs")
    .option("--gpu", "use Chromium's new headless mode with GPU-friendly flags")
    .option("--heap-snapshot <path>", "write an agent-friendly heap snapshot summary after the code runs")
    .option("--network-trace <path>", "write a HAR network trace after the code runs")
    .option("--path <path>", "Vite page path to open")
    .option("--performance-trace <path>", "write a Chrome performance trace after the code runs")
    .option("--record <path>", "write a WebM video recording after the code runs")
    .option(
      "--browser-ws-endpoint <ws-endpoint>",
      "Playwright browser WebSocket endpoint to connect to instead of launching Chromium locally"
    )
    .option("--screenshot <path>", "write a full-page screenshot after the code runs")
    .option("--keep-browser-open", "leave the connected browser running after the code finishes (for --browser-ws-endpoint)")
    .option("--timeout <seconds>", "maximum time to wait for navigation and injected code", parseTimeoutSeconds)
    .showHelpAfterError()
    .parse();

  const [codeParts] = program.processedArgs as [string[]];
  const options = program.opts<CliOptions>();

  try {
    const input = await resolveVitexecCodeInputDetails(codeParts);
    process.stdout.write("logs:\n");
    let hasLogs = false;
    for await (const line of runVitexec(input.code, createRunOptions(options, {
      env: process.env,
      moduleExtension: input.moduleExtension
    }))) {
      hasLogs = true;
      process.stdout.write(`${line}\n`);
    }
    if (!hasLogs) process.stdout.write("(no browser logs captured)\n");
  } catch (error) {
    console.error(`vitexec failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export function createRunOptions(
  options: CliOptions,
  context: {
    env?: Environment;
    moduleExtension?: VitexecModuleExtension;
  } = {}
): RunVitexecOptions {
  const env = context.env ?? process.env;
  const timeout = options.timeout ?? envNumber(env, VITEXEC_ENV.timeout, parseTimeoutSeconds);

  return {
    browserExposeNetwork: options.browserExposeNetwork ?? envString(env, VITEXEC_ENV.browserExposeNetwork),
    browserWsEndpoint: options.browserWsEndpoint ?? envString(env, VITEXEC_ENV.browserWsEndpoint),
    configFile: options.config ?? envString(env, VITEXEC_ENV.config),
    cpuProfilePath: options.cpuProfile ?? envString(env, VITEXEC_ENV.cpuProfile),
    gpu: options.gpu ?? envBoolean(env, VITEXEC_ENV.gpu),
    heapSnapshotPath: options.heapSnapshot ?? envString(env, VITEXEC_ENV.heapSnapshot),
    moduleExtension: context.moduleExtension,
    networkTracePath: options.networkTrace ?? envString(env, VITEXEC_ENV.networkTrace),
    path: options.path ?? envString(env, VITEXEC_ENV.path),
    performanceTracePath: options.performanceTrace ?? envString(env, VITEXEC_ENV.performanceTrace),
    recordPath: options.record ?? envString(env, VITEXEC_ENV.record),
    screenshotPath: options.screenshot ?? envString(env, VITEXEC_ENV.screenshot),
    keepBrowserOpen: options.keepBrowserOpen ?? envBoolean(env, VITEXEC_ENV.keepBrowserOpen),
    timeoutMs: timeout === undefined ? undefined : timeout * 1000
  };
}

function parseTimeoutSeconds(value: string): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new InvalidArgumentError("timeout must be a positive number of seconds");
  }

  return seconds;
}

function envString(env: Environment, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

function envNumber(
  env: Environment,
  name: string,
  parse: (value: string) => number
): number | undefined {
  const value = envString(env, name);
  return value === undefined ? undefined : parse(value);
}

function envBoolean(env: Environment, name: string): boolean | undefined {
  const value = envString(env, name);
  if (value === undefined) return undefined;

  switch (value.toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new InvalidArgumentError(`${name} must be one of: 1, 0, true, false, yes, no, on, off`);
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) {
    return false;
  }

  return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isEntrypoint()) {
  void main();
}
