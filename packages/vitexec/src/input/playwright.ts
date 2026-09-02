import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { VITEXEC_INPUT_BINDING, type InputBindingResult } from "./binding.js";
import { parseInputCommand } from "./parse.js";
import type {
  InputHeldResult,
  InputMouseButton,
  InputMouseClickCommand,
  InputMouseMoveLatestCommand,
  InputMouseMoveLatestResult,
  InputPhysicalCommand,
  InputResult
} from "./types.js";

export type PlaywrightInputLimits = {
  eventIntervalMs: number;
  maximumDurationMs: number;
  maximumSpeedPixelsPerSecond: number;
  minimumDurationMs: number;
};

export const DEFAULT_PLAYWRIGHT_INPUT_LIMITS: PlaywrightInputLimits = {
  eventIntervalMs: 1000 / 60,
  maximumDurationMs: 1500,
  maximumSpeedPixelsPerSecond: 1200,
  minimumDurationMs: 80
};

const LATEST_MOVE_LEASE_MS = 400;

type Point = { x: number; y: number };

type Control =
  | { kind: "key"; key: string }
  | { button: InputMouseButton; kind: "button" };

type Held = {
  control: Control;
  release?: Timer;
};

type Timer = {
  cancel: () => void;
  expiresAt: number;
  task: Promise<void>;
};

type Signal = {
  promise: Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
};

type Latest = {
  deadline: Timer;
  id: number;
  request: InputMouseMoveLatestCommand;
  start: Signal;
  started: boolean;
  target?: Point;
  wake?: () => void;
};

type Operation = {
  perform: () => Promise<void>;
  reject: (error: unknown) => void;
  resolve: () => void;
};

class Dispatcher {
  readonly #motions: Operation[] = [];
  readonly #transitions: Operation[] = [];
  #running = false;

  motion(perform: () => Promise<void>): Promise<void> {
    return this.#enqueue(this.#motions, perform);
  }

  transition(perform: () => Promise<void>): Promise<void> {
    return this.#enqueue(this.#transitions, perform);
  }

  #enqueue(queue: Operation[], perform: () => Promise<void>): Promise<void> {
    const result = new Promise<void>((resolve, reject) => {
      queue.push({ perform, reject, resolve });
    });
    if (!this.#running) void this.#drain();
    return result;
  }

  async #drain(): Promise<void> {
    this.#running = true;
    while (this.#transitions.length > 0 || this.#motions.length > 0) {
      const operation = this.#transitions.shift() ?? this.#motions.shift();
      if (!operation) throw new Error("Vitexec input lost a queued operation.");
      try {
        await operation.perform();
        operation.resolve();
      } catch (error) {
        operation.reject(error);
      }
    }
    this.#running = false;
  }
}

export class InputBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputBusyError";
  }
}

const installedDrivers = new WeakMap<Page, Promise<PlaywrightInputDriver>>();

export async function installPlaywrightInput(page: Page): Promise<PlaywrightInputDriver> {
  const existing = installedDrivers.get(page);
  if (existing) return existing;

  const installation = installDriver(page);
  installedDrivers.set(page, installation);
  try {
    return await installation;
  } catch (error) {
    installedDrivers.delete(page);
    throw error;
  }
}

async function installDriver(page: Page): Promise<PlaywrightInputDriver> {
  const driver = new PlaywrightInputDriver(page);
  await page.exposeBinding(
    VITEXEC_INPUT_BINDING,
    (_source, command: unknown) => driver.run(command)
  );
  return driver;
}

export class PlaywrightInputDriver {
  readonly #backgroundErrors: Error[] = [];
  readonly #backgroundTasks = new Set<Promise<void>>();
  readonly #dispatcher = new Dispatcher();
  readonly #held = new Map<string, Held>();
  readonly #limits: PlaywrightInputLimits;
  readonly #page: Page;
  #accepting = true;
  #latest: Latest | undefined;
  #latestTask: Promise<void> | undefined;
  #mouse: Point = { x: 0, y: 0 };
  #moving = false;
  #nextLatestId = 1;

  constructor(
    page: Page,
    limits: PlaywrightInputLimits = DEFAULT_PLAYWRIGHT_INPUT_LIMITS
  ) {
    validateLimits(limits);
    this.#limits = limits;
    this.#page = page;
  }

  async run(value: unknown): Promise<InputBindingResult> {
    this.#assertAccepting();
    throwErrors(this.#backgroundErrors.splice(0));
    return await this.#run(parseInputCommand(value));
  }

  async finishRun(): Promise<void> {
    if (!this.#accepting) {
      throw new Error("Vitexec input driver is already finishing a run.");
    }
    this.#accepting = false;
    await this.#stopLatest();
    while (this.#backgroundTasks.size > 0) {
      await Promise.all(this.#backgroundTasks);
    }

    const errors = [...this.#backgroundErrors];
    for (const held of [...this.#held.values()]) {
      held.release?.cancel();
      try {
        await this.#up(held.control);
      } catch (error) {
        errors.push(toError(error));
      }
    }

    if (errors.length === 0) this.#accepting = true;
    throwErrors(errors);
  }

  async #run(command: InputPhysicalCommand): Promise<InputResult> {
    switch (command.type) {
      case "wait":
        await delay(command.durationMs);
        return { status: "completed" };
      case "keyboard.down":
        return this.#down(
          { kind: "key", key: command.key },
          command.releaseAfterMs
        );
      case "keyboard.press":
        return this.#press(
          { kind: "key", key: command.key },
          command.durationMs
        );
      case "keyboard.up":
        await this.#up({ kind: "key", key: command.key });
        return { status: "completed" };
      case "mouse.click":
        return this.#click(command);
      case "mouse.down":
        return this.#down(
          { button: command.button ?? "left", kind: "button" },
          command.releaseAfterMs
        );
      case "mouse.press":
        return this.#press(
          { button: command.button ?? "left", kind: "button" },
          command.durationMs
        );
      case "mouse.up":
        await this.#up({ button: command.button ?? "left", kind: "button" });
        return { status: "completed" };
      case "mouse.move":
        return this.#move(
          command.type,
          {
            x: this.#mouse.x + command.deltaX,
            y: this.#mouse.y + command.deltaY
          },
          command.durationMs
        );
      case "mouse.moveTo":
        return this.#move(
          command.type,
          { x: command.x, y: command.y },
          command.durationMs
        );
      case "mouse.moveLatest":
        return this.#moveLatest(command);
      case "mouse.stop":
        await this.#stopLatest();
        return { status: "completed" };
    }
  }

  async #down(
    control: Control,
    requestedReleaseAfterMs?: number,
    rejectHeld = false
  ): Promise<InputHeldResult> {
    const releaseAfterMs = requestedReleaseAfterMs === undefined
      ? undefined
      : this.#boundedDuration(requestedReleaseAfterMs, "releaseAfterMs");
    let result: InputHeldResult | undefined;

    await this.#dispatcher.transition(async () => {
      const id = controlId(control);
      const current = this.#held.get(id);
      if (current) {
        if (rejectHeld) this.#throwHeld(control, "press");
        current.release?.cancel();
        current.release = this.#scheduleRelease(current, releaseAfterMs);
        result = heldResult(false, current.release);
        return;
      }

      await this.#emitDown(control);
      const held: Held = { control };
      this.#held.set(id, held);
      held.release = this.#scheduleRelease(held, releaseAfterMs);
      result = heldResult(true, held.release);
    });

    if (!result) throw new Error("Vitexec input failed to hold a control.");
    return result;
  }

  async #up(control: Control): Promise<void> {
    await this.#dispatcher.transition(async () => {
      const id = controlId(control);
      const held = this.#held.get(id);
      if (!held) return;
      await this.#emitUp(control);
      this.#held.delete(id);
      held.release?.cancel();
    });
  }

  async #press(control: Control, durationMs: number): Promise<InputResult> {
    this.#boundedDuration(durationMs, "durationMs");
    await this.#down(control, undefined, true);
    await delay(durationMs);
    await this.#up(control);
    return { status: "completed" };
  }

  #scheduleRelease(held: Held, durationMs?: number): Timer | undefined {
    if (durationMs === undefined) return undefined;
    const timer = schedule(durationMs, async (cancelled) => {
      if (cancelled() || this.#held.get(controlId(held.control)) !== held) return;
      await this.#up(held.control);
    });
    this.#track(timer.task);
    return timer;
  }

  #emitDown(control: Control): Promise<void> {
    return control.kind === "key"
      ? this.#page.keyboard.down(control.key)
      : this.#page.mouse.down({ button: control.button });
  }

  #emitUp(control: Control): Promise<void> {
    return control.kind === "key"
      ? this.#page.keyboard.up(control.key)
      : this.#page.mouse.up({ button: control.button });
  }

  async #click(command: InputMouseClickCommand): Promise<InputResult> {
    const button = command.button ?? "left";
    await this.#dispatcher.transition(async () => {
      this.#assertMoveAvailable(command.type);
      this.#throwHeld({ button, kind: "button" }, "click");
      if ("target" in command) {
        const locator = this.#page.locator(command.target);
        const box = await locator.boundingBox();
        if (!box) throw new Error(`Vitexec input target is not visible: ${command.target}`);
        this.#mouse = {
          x: box.x + box.width / 2,
          y: box.y + box.height / 2
        };
        await locator.click({ button });
        return;
      }
      this.#mouse = { x: command.x, y: command.y };
      await this.#page.mouse.click(command.x, command.y, { button });
    });
    return { status: "completed" };
  }

  async #move(
    type: "mouse.move" | "mouse.moveTo",
    target: Point,
    requestedDurationMs: number
  ): Promise<InputResult> {
    this.#assertMoveAvailable(type);
    const origin = this.#mouse;
    const distance = Math.hypot(target.x - origin.x, target.y - origin.y);
    const durationMs = movementDuration(distance, requestedDurationMs, this.#limits);
    const steps = Math.max(2, Math.ceil(durationMs / this.#limits.eventIntervalMs));
    const startedAt = performance.now();
    this.#moving = true;
    try {
      for (let step = 1; step <= steps; step += 1) {
        await delay(Math.max(
          0,
          startedAt + durationMs * step / steps - performance.now()
        ));
        const progress = step / steps;
        const eased = progress * progress * (3 - 2 * progress);
        const point = {
          x: origin.x + (target.x - origin.x) * eased,
          y: origin.y + (target.y - origin.y) * eased
        };
        await this.#dispatcher.motion(() => this.#page.mouse.move(point.x, point.y));
        this.#mouse = point;
      }
      return { status: "completed" };
    } finally {
      this.#moving = false;
    }
  }

  async #moveLatest(
    command: InputMouseMoveLatestCommand
  ): Promise<InputMouseMoveLatestResult> {
    this.#assertMoveAvailable(command.type, true);
    if ("deltaX" in command && command.deltaX === 0 && command.deltaY === 0) {
      throw new Error(
        "Vitexec mouse.moveLatest requires movement; call mouse.stop instead."
      );
    }

    const previous = this.#latest;
    previous?.deadline.cancel();
    if (previous && !previous.started) {
      previous.start.reject(
        new Error("Vitexec mouse.moveLatest was replaced before its first pointer event.")
      );
    }

    const id = this.#nextLatestId;
    this.#nextLatestId += 1;
    const latest: Latest = {
      deadline: schedule(LATEST_MOVE_LEASE_MS, () => this.#expireLatest(id)),
      id,
      request: command,
      start: signal(),
      started: false
    };
    this.#latest = latest;
    this.#track(latest.deadline.task);
    previous?.wake?.();
    this.#startLatestLoop();
    await latest.start.promise;
    if (this.#latest !== latest) {
      throw new Error("Vitexec mouse.moveLatest expired before it started.");
    }
    return { leaseMs: LATEST_MOVE_LEASE_MS, status: "latest.started" };
  }

  #startLatestLoop(): void {
    if (this.#latestTask) return;
    const task = this.#track(this.#runLatestLoop());
    this.#latestTask = task;
    void task.then(() => {
      if (this.#latestTask === task) this.#latestTask = undefined;
    });
  }

  async #runLatestLoop(): Promise<void> {
    let dueAt = performance.now();
    while (this.#latest) {
      const latest = this.#latest;
      await waitForLatest(latest, dueAt);
      if (this.#latest !== latest) continue;

      let startedAt: number | undefined;
      try {
        await this.#dispatcher.motion(async () => {
          if (this.#latest !== latest) return;
          startedAt = performance.now();
          latest.target ??= latestTarget(latest.request, this.#mouse);
          const point = nextPoint(
            this.#mouse,
            latest.target,
            this.#limits.maximumSpeedPixelsPerSecond *
              this.#limits.eventIntervalMs / 1000
          );
          if (!point) {
            throw new Error("Vitexec mouse.moveLatest is too small to move the pointer.");
          }
          await this.#page.mouse.move(point.x, point.y);
          this.#mouse = point;
          this.#markLatestStarted(latest);
        });
      } catch (error) {
        this.#failLatest(latest, error);
        if (latest.started) throw error;
        continue;
      }

      if (this.#latest !== latest) continue;
      if (startedAt === undefined) {
        throw new Error("Vitexec latest movement missed its dispatch boundary.");
      }
      dueAt = startedAt + this.#limits.eventIntervalMs;
      if (latest.target && samePoint(this.#mouse, latest.target)) {
        await new Promise<void>((resolve) => {
          latest.wake = resolve;
        });
        latest.wake = undefined;
        dueAt = performance.now();
      }
    }
  }

  #markLatestStarted(latest: Latest): void {
    if (latest.started || this.#latest !== latest) return;
    latest.started = true;
    latest.deadline.cancel();
    latest.deadline = schedule(
      LATEST_MOVE_LEASE_MS,
      () => this.#expireLatest(latest.id)
    );
    this.#track(latest.deadline.task);
    latest.start.resolve();
  }

  async #expireLatest(id: number): Promise<void> {
    const latest = this.#latest;
    if (!latest || latest.id !== id) return;
    this.#latest = undefined;
    if (!latest.started) {
      latest.start.reject(
        new Error("Vitexec mouse.moveLatest expired before its first pointer event.")
      );
    }
    latest.wake?.();
  }

  #failLatest(latest: Latest, error: unknown): void {
    if (this.#latest === latest) this.#latest = undefined;
    latest.deadline.cancel();
    if (!latest.started) latest.start.reject(error);
    latest.wake?.();
  }

  async #stopLatest(): Promise<void> {
    const latest = this.#latest;
    this.#latest = undefined;
    latest?.deadline.cancel();
    if (latest && !latest.started) {
      latest.start.reject(
        new Error("Vitexec mouse.moveLatest stopped before its first pointer event.")
      );
    }
    latest?.wake?.();
    if (this.#latestTask) await this.#latestTask;
  }

  #throwHeld(control: Control, action: "click" | "press"): void {
    if (!this.#held.has(controlId(control))) return;
    throw new InputBusyError(
      `Vitexec input cannot ${action} held ${controlName(control)}.`
    );
  }

  #assertMoveAvailable(type: InputPhysicalCommand["type"], latest = false): void {
    if (!this.#moving && (latest || !this.#latest)) return;
    throw new InputBusyError(
      `Vitexec ${type} cannot start while another pointer movement is active.`
    );
  }

  #boundedDuration(durationMs: number, field: string): number {
    if (durationMs > this.#limits.maximumDurationMs) {
      throw new Error(
        `Vitexec input field "${field}" exceeds the host maximum ` +
        `${this.#limits.maximumDurationMs}ms.`
      );
    }
    return durationMs;
  }

  #assertAccepting(): void {
    if (!this.#accepting) {
      throw new Error("Vitexec input driver cannot accept commands while finishing a run.");
    }
  }

  #track(task: Promise<void>): Promise<void> {
    const observed = task.catch((error: unknown) => {
      this.#backgroundErrors.push(toError(error));
    });
    this.#backgroundTasks.add(observed);
    void observed.then(() => this.#backgroundTasks.delete(observed));
    return observed;
  }
}

function controlId(control: Control): string {
  return control.kind === "key" ? `key:${control.key}` : `button:${control.button}`;
}

function controlName(control: Control): string {
  return control.kind === "key"
    ? `keyboard key "${control.key}"`
    : `${control.button} mouse button`;
}

function heldResult(edgeEmitted: boolean, release?: Timer): InputHeldResult {
  return {
    edgeEmitted,
    expiresAt: release?.expiresAt ?? null,
    status: "held"
  };
}

function schedule(
  durationMs: number,
  run: (cancelled: () => boolean) => Promise<void>
): Timer {
  let cancelled = false;
  let finish = () => {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const task = new Promise<void>((resolve, reject) => {
    finish = resolve;
    timeout = setTimeout(() => {
      timeout = undefined;
      run(() => cancelled).then(resolve, reject);
    }, durationMs);
  });
  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      if (timeout === undefined) return;
      clearTimeout(timeout);
      timeout = undefined;
      finish();
    },
    expiresAt: Date.now() + durationMs,
    task
  };
}

function signal(): Signal {
  let reject = (_error: unknown) => {};
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function waitForLatest(latest: Latest, dueAt: number): Promise<void> {
  const durationMs = Math.max(0, dueAt - performance.now());
  if (durationMs === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, durationMs);
    latest.wake = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

function latestTarget(command: InputMouseMoveLatestCommand, origin: Point): Point {
  if ("x" in command) return { x: Math.round(command.x), y: Math.round(command.y) };
  return {
    x: origin.x + physicalDelta(command.deltaX),
    y: origin.y + physicalDelta(command.deltaY)
  };
}

function physicalDelta(delta: number): number {
  if (delta === 0 || Math.abs(delta) >= 1) return delta;
  return delta < 0 ? -1 : 1;
}

function nextPoint(origin: Point, target: Point, maximumStep: number): Point | undefined {
  const deltaX = target.x - origin.x;
  const deltaY = target.y - origin.y;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance === 0) return undefined;
  if (distance <= maximumStep) return target;
  const scale = maximumStep / distance;
  const point = {
    x: Math.round(origin.x + deltaX * scale),
    y: Math.round(origin.y + deltaY * scale)
  };
  return samePoint(point, origin) ? undefined : point;
}

function movementDuration(
  distance: number,
  requestedDurationMs: number,
  limits: PlaywrightInputLimits
): number {
  const durationMs = Math.max(
    limits.minimumDurationMs,
    requestedDurationMs,
    1.5 * distance * 1000 / limits.maximumSpeedPixelsPerSecond
  );
  if (durationMs > limits.maximumDurationMs) {
    throw new Error(
      `Vitexec mouse movement requires ${Math.ceil(durationMs)}ms, exceeding ` +
      `the ${limits.maximumDurationMs}ms limit.`
    );
  }
  return durationMs;
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function throwErrors(errors: Error[]): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "Multiple Vitexec input operations failed.");
}

function validateLimits(limits: PlaywrightInputLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Vitexec Playwright input limit "${name}" must be positive.`);
    }
  }
  if (limits.minimumDurationMs > limits.maximumDurationMs) {
    throw new Error("Vitexec minimum input duration cannot exceed its maximum duration.");
  }
}
