import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, unlink } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { validateRunOptions, VITEXEC_TIMEOUT_MS } from "./options.js";
import { openPage, type OpenPageOptions } from "./page.js";
import { run, type PageRunOptions } from "./run.js";

type Request = { code: string; options: PageRunOptions };

async function address(name: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Session names must contain only letters, numbers, underscores or hyphens.");
  const root = await realpath(process.cwd());
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const directory = join(tmpdir(), `vitexec-${process.getuid?.() ?? "user"}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return process.platform === "win32" ? `\\\\.\\pipe\\vitexec-${id}-${name}` : join(directory, `${id}-${name}.sock`);
}

function send(socket: Socket, message: object) {
  if (!socket.destroyed && !socket.writableEnded) socket.write(`${JSON.stringify(message)}\n`);
}

function request(value: unknown): Request {
  if (typeof value !== "object" || value === null || !("code" in value) || typeof value.code !== "string" || !("options" in value)) throw new Error("Invalid run request.");
  const options = value.options;
  if (typeof options !== "object" || options === null) throw new Error("Invalid run options.");
  const parsed: PageRunOptions = {};
  for (const key of ["cpuProfilePath", "heapSnapshotPath", "performanceTracePath", "recordPath", "screenshotPath"] as const) {
    if (!(key in options)) continue;
    const field: unknown = Reflect.get(options, key);
    if (typeof field !== "string") throw new Error(`Invalid ${key}.`);
    parsed[key] = field;
  }
  for (const key of ["timeoutMs", "recordFps"] as const) {
    if (!(key in options)) continue;
    const field: unknown = Reflect.get(options, key);
    if (typeof field !== "number") throw new Error(`Invalid ${key}.`);
    parsed[key] = field;
  }
  if ("recordAudio" in options) {
    if (typeof options.recordAudio !== "boolean") throw new Error("Invalid recordAudio.");
    parsed.recordAudio = options.recordAudio;
  }
  if ("moduleExtension" in options) {
    const extension = options.moduleExtension;
    if (extension !== ".js" && extension !== ".ts" && extension !== ".jsx" && extension !== ".tsx" && extension !== ".mjs" && extension !== ".mts") throw new Error("Invalid moduleExtension.");
    parsed.moduleExtension = extension;
  }
  validateRunOptions(parsed);
  return { code: value.code, options: parsed };
}

export async function openSession(name: string, options: OpenPageOptions): Promise<void> {
  const path = await address(name);
  const sockets = new Set<Socket>();
  let page: Awaited<ReturnType<typeof openPage>> | undefined;
  let stop: () => void = () => {};
  const stopped = new Promise<void>(resolve => { stop = resolve; });
  let closing = false;
  let closeError: unknown;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", error => options.onLog?.(`[session connection] ${error.message}`));
    const lines = createInterface({ input: socket });
    lines.on("error", error => options.onLog?.(`[session connection] ${error.message}`));
    lines.once("line", line => {
      void (async () => {
        const message = request(JSON.parse(line));
        const deadline = Date.now() + (message.options.timeoutMs ?? VITEXEC_TIMEOUT_MS);
        const ready = await within(startup, deadline);
        if (closing || socket.destroyed) throw new Error("Session is closing or client disconnected.");
        await run(ready, message.code, { ...message.options, timeoutMs: remaining(deadline), onLog: line => send(socket, { log: line }) });
        send(socket, { done: true });
        socket.end();
      })().catch(error => {
        send(socket, { error: error instanceof Error ? error.message : String(error) });
        socket.end();
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
  const controller = new AbortController();
  const startup = (async () => {
    if (process.platform !== "win32") await chmod(path, 0o600);
    return openPage({ ...options, signal: controller.signal });
  })();
  const signal = () => { closing = true; controller.abort(new Error("Session stopped.")); stop(); };
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  try {
    page = await startup;
    page.on("close", stop);
    await stopped;
  } catch (error) {
    for (const socket of sockets) send(socket, { error: error instanceof Error ? error.message : String(error) });
    if (!controller.signal.aborted || error !== controller.signal.reason) throw error;
  } finally {
    closing = true;
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    try { await page?.close(); } catch (error) { closeError = error; }
    try {
      for (const socket of sockets) {
        send(socket, closeError ? { error: String(closeError) } : { error: "Session stopped; execution interrupted." });
        socket.end();
      }
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (process.platform !== "win32") await unlink(path).catch((error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
      });
    } finally { if (closeError) throw closeError; }
  }
}

export async function callSession(name: string, message: Request, log: (line: string) => void): Promise<void> {
  const path = await address(name);
  validateRunOptions(message.options);
  const deadline = Date.now() + (message.options.timeoutMs ?? VITEXEC_TIMEOUT_MS);
  const socket = await connectSession(path, Math.min(deadline, Date.now() + 1000));
  await within(new Promise<void>((resolve, reject) => {
    let finished = false;
    socket.on("error", reject);
    socket.on("close", () => { if (!finished) reject(new Error(`Session ${name} disconnected before execution completed.`)); });
    const lines = createInterface({ input: socket });
    lines.on("error", reject);
    lines.on("line", line => {
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "object" || value === null) throw new Error("Invalid session response.");
        if ("log" in value && typeof value.log === "string") { log(value.log); return; }
        if ("error" in value && typeof value.error === "string") throw new Error(value.error);
        if ("done" in value && value.done === true) {
          finished = true; resolve(); return;
        }
        throw new Error("Invalid session response.");
      } catch (error) { finished = true; reject(error); }
    });
    send(socket, { ...message, options: { ...message.options, timeoutMs: remaining(deadline) } });
  }), deadline).finally(() => socket.destroy());
}

async function connectSession(path: string, deadline: number): Promise<Socket> {
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(path);
        socket.once("error", reject);
        socket.once("connect", () => { socket.off("error", reject); resolve(socket); });
      });
    } catch (error) {
      if ((!hasCode(error, "ENOENT") && !hasCode(error, "ECONNREFUSED")) || Date.now() >= deadline) throw error;
      await delay(Math.min(25, remaining(deadline)));
    }
  }
}

function remaining(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new Error("Session run timed out.");
  return ms;
}

async function within<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Session run timed out.")), remaining(deadline));
    })]);
  } finally { clearTimeout(timer); }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
