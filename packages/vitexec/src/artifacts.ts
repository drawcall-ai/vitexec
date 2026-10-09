import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Page } from "playwright";
import { openCdp, type Cdp } from "./cdp.js";
import { ensureParentDir, writeJson } from "./files.js";
import { saveHeapSnapshotSummary } from "./heap.js";
import type { PageRunOptions } from "./run.js";

export async function saveScreenshot(
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

async function startPerformanceTrace(cdp: Cdp): Promise<PerformanceTraceCapture> {
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

async function finishCpuProfile(cdp: Cdp, path?: string): Promise<void> {
  const result = await cdp.send("Profiler.stop");
  if (path) await writeJson(path, result.profile);
}

async function finishTrace(
  cdp: Cdp,
  trace: PerformanceTraceCapture,
  path?: string
): Promise<void> {
  await cdp.send("Tracing.end");
  await cdp.wait(trace.complete);
  if (path) await writeJson(path, { traceEvents: trace.events });
}

type Recording = { stream: string };

async function startRecording(
  cdp: Cdp,
  page: Page,
  options: Pick<PageRunOptions, "recordAudio" | "recordFps">
): Promise<Recording> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Recording requires a Playwright viewport.");

  return cdp.send("Page.startScreenRecording", {
    audio: options.recordAudio ?? true,
    frameRate: options.recordFps ?? 60,
    maxWidth: viewport.width,
    maxHeight: viewport.height
  });
}

async function finishRecording(cdp: Cdp, recording: Recording, path?: string): Promise<void> {
  const stopped = await cdp.send("Page.stopScreenRecording");
  if (stopped.stream !== recording.stream) {
    throw new Error("Chromium returned a different recording stream when stopping.");
  }
  if (!path) {
    await cdp.send("IO.close", { handle: stopped.stream });
    return;
  }
  await ensureParentDir(path);
  await pipeline(readCdpStream(cdp, stopped.stream), createWriteStream(path));
}

async function* readCdpStream(cdp: Cdp, stream: string): AsyncGenerator<Buffer> {
  const errors: unknown[] = [];
  try {
    for (;;) {
      const chunk = await cdp.send("IO.read", { handle: stream, size: 1024 * 1024 });
      if (chunk.data) {
        yield Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
      }
      if (chunk.eof) break;
    }
  } catch (error) {
    errors.push(error);
  } finally {
    try { await cdp.send("IO.close", { handle: stream }); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Failed to read and close recording stream.");
  }
}

export async function capture(page: Page, options: PageRunOptions, log: (line: string) => void) {
  const cdp = await openCdp(page);
  let recording: Recording | undefined;
  let trace: PerformanceTraceCapture | undefined;
  let cpu = false;

  const finish = async (save: boolean): Promise<void> => {
    if (page.isClosed()) {
      await cdp.detach();
      if (save) throw new Error("Page closed before captures could be saved.");
      return;
    }
    const results = await Promise.allSettled([
      cpu ? finishCpuProfile(cdp, save ? options.cpuProfilePath : undefined) : undefined,
      trace ? finishTrace(cdp, trace, save ? options.performanceTracePath : undefined) : undefined,
      recording ? finishRecording(cdp, recording, save ? options.recordPath : undefined) : undefined
    ]);
    const errors: unknown[] = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (save && !errors.length) {
      try {
        if (options.heapSnapshotPath) await saveHeapSnapshotSummary(cdp, options.heapSnapshotPath);
        for (const [name, path] of [
          ["cpu-profile", options.cpuProfilePath],
          ["performance-trace", options.performanceTracePath],
          ["heap-snapshot", options.heapSnapshotPath],
          ["recording", options.recordPath]
        ]) {
          if (path) log(`[${name}] ${path}`);
        }
      } catch (error) { errors.push(error); }
    }
    try { await cdp.detach(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "Failed to finish Vitexec captures.");
  };

  try {
    if (options.recordPath) recording = await startRecording(cdp, page, options);
    if (options.cpuProfilePath) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.start");
      cpu = true;
    }
    if (options.performanceTracePath) trace = await startPerformanceTrace(cdp);
    return { finish };
  } catch (error) {
    try { await finish(false); } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Failed to start Vitexec captures and clean up.");
    }
    throw error;
  }
}
