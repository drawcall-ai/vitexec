import type { CDPSession } from "playwright";
import type { Loaded, Strict } from "./api.js";

// Reads are evaluated through V8's debug-evaluate side-effect check: any store
// to pre-existing state, timer, promise, or DOM mutation aborts the call, so a
// strict script can inspect the app but never change it. There is deliberately
// no watchdog: Runtime.terminateExecution would kill whatever page code is
// running when it fires, including the app's own boot; a runaway read is
// bounded by the run timeout instead.
const SIDE_EFFECT_MARKER = "Possible side-effect in debug-evaluate";

export type Observer = Pick<Strict, "observe" | "load">;

export async function createObserver(cdp: CDPSession): Promise<Observer> {
  const window = await cdp.send("Runtime.evaluate", { expression: "globalThis" });
  const windowId = window.result.objectId;
  if (!windowId) throw new Error("Vitexec could not reach the page's global object.");
  const modules = new Map<string, string>();

  async function load<T>(specifier: string): Promise<Loaded<T>> {
    const module = await cdp.send("Runtime.evaluate", {
      expression: `import(${JSON.stringify(specifier)})`,
      awaitPromise: true
    });
    if (module.exceptionDetails) {
      throw new Error(`load(${JSON.stringify(specifier)}) failed: ${describe(module.exceptionDetails)}`);
    }
    if (!module.result.objectId) throw new Error(`load(${JSON.stringify(specifier)}) returned no module.`);
    modules.set(specifier, module.result.objectId);
    return { specifier };
  }

  const observe: Strict["observe"] = async (fn, ...args) => {
    const result = await cdp.send("Runtime.callFunctionOn", {
      functionDeclaration: fn.toString(),
      objectId: windowId,
      arguments: args.map((arg) => callArgument(arg, modules)),
      returnByValue: true,
      throwOnSideEffect: true
    });
    if (!result.exceptionDetails) return result.result.value as ReturnType<typeof fn>;

    const description = describe(result.exceptionDetails);
    if (description.includes(SIDE_EFFECT_MARKER)) {
      throw new Error(
        "observe() must be read-only: V8 rejected this call. Besides writes, timers, promises, and " +
        "DOM changes, it rejects app functions that construct class instances or read imported " +
        `bindings; read plain fields and re-derive the value in the script instead: ${fn}`
      );
    }
    throw new Error(`observe() threw: ${description}`);
  };

  return { load, observe };
}

function callArgument(
  arg: unknown,
  modules: Map<string, string>
): { objectId: string } | { value: unknown } {
  if (!isLoaded(arg)) return { value: arg };
  const objectId = modules.get(arg.specifier);
  if (!objectId) throw new Error(`Unknown module handle ${JSON.stringify(arg.specifier)}; call load() first.`);
  return { objectId };
}

function isLoaded(value: unknown): value is Loaded<unknown> {
  return typeof value === "object" && value !== null && "specifier" in value &&
    typeof value.specifier === "string";
}

function describe(details: { exception?: { description?: string }; text: string }): string {
  return details.exception?.description ?? details.text;
}
