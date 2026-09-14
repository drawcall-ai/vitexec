import type { Page, CDPSession } from "playwright";

type Stack = { callFrames: { url: string }[]; parent?: Stack; parentId?: { id: string; debuggerId?: string } };
type Value = { type: string; value?: unknown; unserializableValue?: string; description?: string; objectId?: string };
type Message = { type: string; args: Value[]; stackTrace?: Stack };
export type Listener = { log(line: string): void; fail(error: Error): void };

const collectors = new WeakMap<Page, Promise<Collector>>();
export type Collector = Awaited<ReturnType<typeof collect>>;

export function logs(page: Page): Promise<Collector> {
  let pending = collectors.get(page);
  if (!pending) {
    pending = collect(page);
    collectors.set(page, pending);
    void pending.catch(() => collectors.delete(page));
  }
  return pending;
}

async function collect(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const runs = new Map<string, Listener>();
  const known = new Set<string>();
  let pageLog: (line: string) => void = () => {};
  let pending = Promise.resolve();
  let failure: Error | undefined;
  const fail = (cause: unknown) => {
    failure = cause instanceof Error ? cause : new Error(String(cause));
    for (const listener of runs.values()) listener.fail(failure);
  };
  const emit = (line: string) => {
    try { pageLog(line); } catch (error) { fail(error); }
  };
  const owner = (source: string): string | undefined => {
    const matches = [...known].filter(id => source.includes(id));
    return matches.length === 1 ? matches[0] : undefined;
  };
  const receive = async (message: Message) => {
    const urls: string[] = [];
    let stack = message.stackTrace;
    for (let depth = 0; stack && depth < 32; depth++) {
      urls.push(...stack.callFrames.map(frame => frame.url));
      if (stack.parent) { stack = stack.parent; continue; }
      if (!stack.parentId) break;
      try {
        stack = (await cdp.send("Debugger.getStackTrace", { stackTraceId: stack.parentId })).stackTrace;
      } catch (error) {
        // Navigation can invalidate an async stack before it is retrieved.
        emit(`[log attribution] ${String(error)}`);
        urls.length = 0;
        break;
      }
    }
    const values = await Promise.all(message.args.map(value => format(cdp, value)));
    const text = values.join(" ");
    if (message.type === "debug" && text.startsWith("[vite] ")) return;
    const id = owner(urls.join("\n"));
    const listener = id ? runs.get(id) : undefined;
    const line = `[${message.type}] ${text}`;
    if (!listener) { emit(id ? `[late ${id}] ${line}` : line); return; }
    try { listener.log(line); } catch (error) {
      listener.fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  cdp.on("Runtime.consoleAPICalled", (message: Message) => {
    pending = pending.then(() => receive(message)).catch(fail);
  });
  page.on("pageerror", error => emit(`[page error] ${error.message}`));
  page.on("requestfailed", request => emit(`[request failed] ${request.url()} ${request.failure()?.errorText}`));
  page.on("response", response => {
    if (response.status() >= 400) emit(`[http ${response.status()}] ${response.url()}`);
  });
  page.on("close", () => fail(new Error("Page closed; execution interrupted.")));
  page.on("crash", () => fail(new Error("Page crashed; execution interrupted.")));
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Debugger.enable");
    await cdp.send("Debugger.setAsyncCallStackDepth", { maxDepth: 32 });
  } catch (error) {
    await cdp.detach();
    throw error;
  }
  return {
    owner,
    setPageLog(callback: (line: string) => void) { pageLog = callback; },
    add(id: string, listener: Listener) {
      if (failure) throw failure;
      known.add(id);
      runs.set(id, listener);
    },
    remove(id: string) { runs.delete(id); },
    async drain() {
      await cdp.send("Runtime.evaluate", { expression: "void 0" });
      await pending;
      if (failure) throw failure;
    }
  };
}

async function format(cdp: CDPSession, value: Value): Promise<string> {
  if (value.type === "string") return String(value.value);
  if (value.value !== undefined) return JSON.stringify(value.value);
  if (!value.objectId) return value.unserializableValue ?? value.description ?? value.type;
  const result = await cdp.send("Runtime.callFunctionOn", {
    objectId: value.objectId,
    functionDeclaration: "function () { try { return JSON.stringify(this); } catch { return String(this); } }",
    returnByValue: true
  });
  return String(result.result.value ?? value.description ?? value.type);
}
