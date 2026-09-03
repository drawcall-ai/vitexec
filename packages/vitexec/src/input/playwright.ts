import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "playwright";
import { INPUT_BINDING, type InputCommand } from "./api.js";

export const MOUSE_SPEED_PX_PER_S = 1200;
export const MOUSE_EVENT_HZ = 60;
export const INPUT_DEFAULT_DURATION_MS = 80;
export const MOUSE_MAX_DURATION_MS = 1500;
const MOVE_INTERVAL_MS = 1000 / MOUSE_EVENT_HZ;
const MOVE_LEASE_MS = 400;

type Point = { x: number; y: number };
type Destination = (origin: Point) => Point;
type Motion = {
  cancelled: boolean;
  done: Promise<void>;
  kind: "latest" | "settled";
};
type Held = {
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  up: () => Promise<void>;
};

export type Input = {
  release(): Promise<void>;
  run(command: InputCommand): Promise<void>;
};

const inputs = new WeakMap<Page, Input>();

export async function installInput(page: Page): Promise<Input> {
  const existing = inputs.get(page);
  if (existing) return existing;

  const input = createInput(page);
  await page.exposeBinding(INPUT_BINDING, (_source, command: InputCommand) => input.run(command));
  inputs.set(page, input);
  return input;
}

function createInput(page: Page): Input {
  let position = { x: 0, y: 0 };
  let motion: Motion | undefined;
  let focused = false;
  const held = new Map<string, Held>();
  const errors: unknown[] = [];

  const ready = async (): Promise<void> => {
    throwErrors(errors.splice(0));
    if (focused) return;
    await page.bringToFront();
    focused = true;
  };

  const stopMotion = async (): Promise<void> => {
    const active = motion;
    if (!active) return;
    active.cancelled = true;
    await active.done;
    if (motion === active) motion = undefined;
  };

  const settled = async (destination: Destination, requested?: number): Promise<void> => {
    if (motion) throw new Error("Vitexec mouse is already moving.");

    const origin = { ...position };
    const target = destination(origin);
    finitePoint(target);
    const distance = Math.hypot(target.x - origin.x, target.y - origin.y);
    if (distance === 0) return;

    const durationMs = moveDuration(distance, requested);
    const steps = Math.max(2, Math.ceil(durationMs / MOVE_INTERVAL_MS));
    const startedAt = performance.now();
    const active: Motion = {
      cancelled: false,
      done: Promise.resolve(),
      kind: "settled"
    };
    active.done = (async () => {
      for (let step = 1; step <= steps && !active.cancelled; step += 1) {
        await delay(Math.max(0, startedAt + durationMs * step / steps - performance.now()));
        if (active.cancelled) return;
        const progress = smoothstep(step / steps);
        const next = {
          x: origin.x + (target.x - origin.x) * progress,
          y: origin.y + (target.y - origin.y) * progress
        };
        await page.mouse.move(next.x, next.y);
        position = next;
      }
    })();
    motion = active;
    try {
      await active.done;
    } finally {
      if (motion === active) motion = undefined;
    }
  };

  const replace = async (destination: Destination): Promise<void> => {
    if (motion?.kind === "settled") throw new Error("Vitexec mouse is already moving.");
    await stopMotion();
    throwErrors(errors.splice(0));

    const requested = destination(position);
    finitePoint(requested);
    const target = { x: Math.round(requested.x), y: Math.round(requested.y) };
    const first = nextPoint(position, target);
    if (!first) throw new Error("Vitexec mouse movement requires a different destination.");
    await page.mouse.move(first.x, first.y);
    position = first;
    if (samePoint(position, target)) return;

    const active: Motion = {
      cancelled: false,
      done: Promise.resolve(),
      kind: "latest"
    };
    active.done = (async () => {
      const expiresAt = performance.now() + MOVE_LEASE_MS;
      while (!active.cancelled && performance.now() < expiresAt) {
        await delay(MOVE_INTERVAL_MS);
        if (active.cancelled) return;
        const next = nextPoint(position, target);
        if (!next) return;
        await page.mouse.move(next.x, next.y);
        position = next;
        if (samePoint(position, target)) return;
      }
    })().catch((error: unknown) => {
      errors.push(error);
    });
    motion = active;
    void active.done.then(() => {
      if (motion === active) motion = undefined;
    });
  };

  const up = async (id: string): Promise<void> => {
    const active = held.get(id);
    if (!active) return;
    if (active.pending) return active.pending;
    if (active.timer) clearTimeout(active.timer);
    active.pending = active.up().then(
      () => {
        if (held.get(id) === active) held.delete(id);
      },
      (error: unknown) => {
        active.pending = undefined;
        throw error;
      }
    );
    return active.pending;
  };

  const arm = (id: string, active: Held, releaseAfterMs?: number): void => {
    if (active.timer) clearTimeout(active.timer);
    active.timer = undefined;
    if (releaseAfterMs === undefined) return;
    active.timer = setTimeout(() => {
      void up(id).catch((error: unknown) => {
        errors.push(error);
      });
    }, releaseAfterMs);
  };

  const down = async (
    id: string,
    press: () => Promise<void>,
    release: () => Promise<void>,
    releaseAfterMs?: number
  ): Promise<void> => {
    if (releaseAfterMs !== undefined) positiveDuration(releaseAfterMs);
    let active = held.get(id);
    if (active?.pending) {
      await active.pending;
      active = held.get(id);
    }
    if (!active) {
      await press();
      active = { up: release };
      held.set(id, active);
    }
    arm(id, active, releaseAfterMs);
  };

  const press = async (
    id: string,
    pressDown: () => Promise<void>,
    pressUp: () => Promise<void>,
    requested?: number
  ): Promise<void> => {
    if (held.has(id)) throw new Error(`Vitexec input ${id} is already held.`);
    const durationMs = positiveDuration(requested);
    await down(id, pressDown, pressUp);
    await delay(durationMs);
    await up(id);
  };

  return {
    async run(command) {
      await ready();
      switch (command.type) {
        case "mouse.move":
          return settled(({ x, y }) => ({
            x: x + physicalDelta(command.deltaX),
            y: y + physicalDelta(command.deltaY)
          }), command.durationMs);
        case "mouse.moveTo":
          return settled(() => ({ x: command.x, y: command.y }), command.durationMs);
        case "mouse.moveLatest":
          return replace(({ x, y }) => ({
            x: x + physicalDelta(command.deltaX),
            y: y + physicalDelta(command.deltaY)
          }));
        case "mouse.moveToLatest":
          return replace(() => ({ x: command.x, y: command.y }));
        case "mouse.stop":
          await stopMotion();
          return throwErrors(errors.splice(0));
        case "mouse.down":
          return down(
            `mouse:${command.button}`,
            () => page.mouse.down({ button: command.button }),
            () => page.mouse.up({ button: command.button }),
            command.releaseAfterMs
          );
        case "mouse.up":
          return up(`mouse:${command.button}`);
        case "mouse.click":
          return press(
            `mouse:${command.button}`,
            () => page.mouse.down({ button: command.button }),
            () => page.mouse.up({ button: command.button }),
            command.durationMs
          );
        case "keyboard.down":
          return down(
            `key:${command.key}`,
            () => page.keyboard.down(command.key),
            () => page.keyboard.up(command.key),
            command.releaseAfterMs
          );
        case "keyboard.up":
          return up(`key:${command.key}`);
        case "keyboard.press":
          return press(
            `key:${command.key}`,
            () => page.keyboard.down(command.key),
            () => page.keyboard.up(command.key),
            command.durationMs
          );
      }
    },
    async release() {
      focused = false;
      for (const active of held.values()) {
        if (active.timer) clearTimeout(active.timer);
      }
      await stopMotion();
      const released = await Promise.allSettled([...held.keys()].map(up));
      for (const result of released) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      throwErrors(errors);
    }
  };
}

function moveDuration(distance: number, requested?: number): number {
  if (requested !== undefined) mouseDuration(requested);
  const duration = Math.max(
    INPUT_DEFAULT_DURATION_MS,
    requested ?? 0,
    1.5 * distance * 1000 / MOUSE_SPEED_PX_PER_S
  );
  if (duration > MOUSE_MAX_DURATION_MS) {
    throw new Error(`Vitexec mouse movement requires ${Math.ceil(duration)}ms.`);
  }
  return duration;
}

function positiveDuration(value = INPUT_DEFAULT_DURATION_MS): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("Vitexec input duration must be a finite number greater than zero.");
  }
  return value;
}

function mouseDuration(value: number): number {
  const duration = positiveDuration(value);
  if (duration > MOUSE_MAX_DURATION_MS) {
    throw new Error(`Vitexec mouse movement duration must be at most ${MOUSE_MAX_DURATION_MS}ms.`);
  }
  return duration;
}

function finitePoint(point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("Vitexec mouse coordinates must be finite numbers.");
  }
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function nextPoint(origin: Point, target: Point): Point | undefined {
  const deltaX = target.x - origin.x;
  const deltaY = target.y - origin.y;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance === 0) return undefined;
  if (distance <= MOUSE_SPEED_PX_PER_S / MOUSE_EVENT_HZ) return target;
  const scale = MOUSE_SPEED_PX_PER_S / MOUSE_EVENT_HZ / distance;
  return {
    x: Math.round(origin.x + deltaX * scale),
    y: Math.round(origin.y + deltaY * scale)
  };
}

function samePoint(left: Point, right: Point): boolean {
  return left.x === right.x && left.y === right.y;
}

function physicalDelta(delta: number): number {
  if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) >= 1) return delta;
  return delta < 0 ? -1 : 1;
}

function throwErrors(errors: unknown[]): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "Multiple Vitexec input operations failed.");
}
