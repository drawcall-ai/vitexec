// The public surface of a strict script. A strict script runs in the vitexec
// process, not in the page: these are the only ways it can touch the app.
// A strict script imports these from "vitexec" for types; the import is
// stripped before it runs, so the stubs only fire when such a script is run
// without `--strict`.

export type MouseButton = "left" | "middle" | "right";

/** A page module handle returned by `load`; pass it to `observe` to read from it. */
export type Loaded<T> = { readonly specifier: string; readonly __module?: T };

type Unwrapped<A extends readonly unknown[]> = {
  [K in keyof A]: A[K] extends Loaded<infer T> ? T : A[K];
};

export type Strict = {
  /**
   * Run `fn` inside the page with V8's side-effect check enabled and return
   * its JSON result. `fn` is serialized, so it cannot close over script
   * variables: pass them as `args`. Any write, timer, promise, or DOM change
   * inside `fn` rejects with "observe() must be read-only".
   */
  observe<A extends readonly unknown[], R>(
    fn: (...args: Unwrapped<A>) => R,
    ...args: A
  ): Promise<R>;
  /** Import a page module (for example `/src/store.ts`) so `observe` can read from it. */
  load<T = Record<string, unknown>>(specifier: string): Promise<Loaded<T>>;
  mouse: {
    /** Current pointer position in CSS pixels; unbounded under pointer lock. */
    readonly position: { readonly x: number; readonly y: number };
    /** Glide by a relative delta at a bounded human speed; resolves when the pointer arrives. */
    move(deltaX: number, deltaY: number): Promise<void>;
    /** Glide to an absolute viewport point at a bounded human speed. */
    moveTo(x: number, y: number): Promise<void>;
    down(button?: MouseButton): Promise<void>;
    up(button?: MouseButton): Promise<void>;
    /** Press and release at the current position. */
    click(button?: MouseButton): Promise<void>;
  };
  keyboard: {
    /** `key` is a Playwright key name such as "KeyW", "Space", "Shift", or "Enter". */
    down(key: string): Promise<void>;
    up(key: string): Promise<void>;
    press(key: string): Promise<void>;
  };
  sleep(ms: number): Promise<void>;
};

function outsideStrictRun(): never {
  throw new Error("observe, load, mouse, keyboard, and sleep exist only for scripts run with `vitexec --strict`.");
}

export const observe: Strict["observe"] = outsideStrictRun;
export const load: Strict["load"] = outsideStrictRun;
export const sleep: Strict["sleep"] = outsideStrictRun;
export const mouse: Strict["mouse"] = {
  get position(): { x: number; y: number } {
    return outsideStrictRun();
  },
  move: outsideStrictRun,
  moveTo: outsideStrictRun,
  down: outsideStrictRun,
  up: outsideStrictRun,
  click: outsideStrictRun
};
export const keyboard: Strict["keyboard"] = {
  down: outsideStrictRun,
  up: outsideStrictRun,
  press: outsideStrictRun
};
