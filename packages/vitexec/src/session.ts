import { createHash } from "node:crypto";
import { chmod, mkdir, realpath, unlink } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { openPage, type OpenPageOptions } from "./page.js";
import { run, type PageRunOptions } from "./run.js";

type Request = { command: "close" } | { command: "run"; code: string; options: PageRunOptions };

async function address(name: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error("Session names must contain only letters, numbers, underscores or hyphens.");
  const root = await realpath(process.cwd());
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  const directory = join(tmpdir(), `vitexec-${process.getuid?.() ?? "user"}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return process.platform === "win32" ? `\\\\.\\pipe\\vitexec-${id}-${name}` : join(directory, `${id}-${name}.sock`);
}

function send(socket: Socket, message: object) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function request(value: unknown): Request {
  if (typeof value !== "object" || value === null || !("command" in value)) throw new Error("Invalid session request.");
  if (value.command === "close") return { command: "close" };
  if (value.command !== "run" || !("code" in value) || typeof value.code !== "string" || !("options" in value)) throw new Error("Invalid run request.");
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
  return { command: "run", code: value.code, options: parsed };
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
        if (message.command === "close") { closing = true; stop(); return; }
        if (closing || !page) throw new Error("Session is not ready or is closing.");
        await run(page, message.code, { ...message.options, onLog: line => send(socket, { log: line }) });
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
  const signal = () => { closing = true; stop(); };
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  try {
    if (process.platform !== "win32") await chmod(path, 0o600);
    page = await openPage(options);
    options.onLog?.(`[ready] ${name} ${page.url()}`);
    page.on("close", stop);
    await stopped;
  } finally {
    closing = true;
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    try { await page?.close(); } catch (error) { closeError = error; }
    try {
      for (const socket of sockets) {
        send(socket, closeError ? { error: String(closeError) } : { closed: true });
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
  await new Promise<void>((resolve, reject) => {
    const socket = connect(path);
    let finished = false;
    socket.on("connect", () => send(socket, message));
    const failed = (error: Error) => {
      if (message.command === "close" && (hasCode(error, "ENOENT") || hasCode(error, "ECONNREFUSED"))) {
        finished = true; resolve(); return;
      }
      reject(error);
    };
    socket.on("error", failed);
    socket.on("close", () => { if (!finished) reject(new Error(`Session ${name} disconnected before execution completed.`)); });
    const lines = createInterface({ input: socket });
    lines.on("error", failed);
    lines.on("line", line => {
      try {
        const value: unknown = JSON.parse(line);
        if (typeof value !== "object" || value === null) throw new Error("Invalid session response.");
        if ("log" in value && typeof value.log === "string") { log(value.log); return; }
        if ("error" in value && typeof value.error === "string") throw new Error(value.error);
        if ("done" in value || ("closed" in value && message.command === "close")) {
          finished = true; resolve(); socket.end(); return;
        }
        throw new Error("Session closed; execution interrupted.");
      } catch (error) { finished = true; reject(error); socket.destroy(); }
    });
  });
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
