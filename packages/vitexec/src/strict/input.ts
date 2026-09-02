import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import type { MouseButton, Strict } from "./api.js";

// Pointer moves are delivered as a stream of real Chromium input events paced
// like a hand: a fixed event rate and a speed ceiling, so no single event
// teleports the pointer and the app sees the whole path.
export const MOUSE_SPEED_PX_PER_S = 3000;
export const MOUSE_EVENT_HZ = 125;
const PRESS_MS = 60;

export type Input = Pick<Strict, "mouse" | "keyboard"> & {
  /** Release every key and button the script left held. */
  release(): Promise<void>;
};

export function createInput(page: Page): Input {
  const position = { x: 0, y: 0 };
  const heldKeys = new Set<string>();
  const heldButtons = new Set<MouseButton>();
  let motion = Promise.resolve();

  const glide = (targetX: number, targetY: number): Promise<void> => {
    const run = motion.then(async () => {
      const origin = { ...position };
      const distance = Math.hypot(targetX - origin.x, targetY - origin.y);
      const steps = Math.max(1, Math.ceil(distance / MOUSE_SPEED_PX_PER_S * MOUSE_EVENT_HZ));
      const startedAt = performance.now();
      for (let step = 1; step <= steps; step += 1) {
        const progress = step / steps;
        position.x = Math.round(origin.x + (targetX - origin.x) * progress);
        position.y = Math.round(origin.y + (targetY - origin.y) * progress);
        await page.mouse.move(position.x, position.y);
        const due = startedAt + step * 1000 / MOUSE_EVENT_HZ;
        await sleep(Math.max(0, due - performance.now()));
      }
    });
    motion = run.catch(() => undefined);
    return run;
  };

  const mouse: Strict["mouse"] = {
    position,
    move: (deltaX, deltaY) => glide(position.x + deltaX, position.y + deltaY),
    moveTo: glide,
    async down(button = "left") {
      await page.mouse.down({ button });
      heldButtons.add(button);
    },
    async up(button = "left") {
      await page.mouse.up({ button });
      heldButtons.delete(button);
    },
    async click(button = "left") {
      await mouse.down(button);
      await sleep(PRESS_MS);
      await mouse.up(button);
    }
  };

  const keyboard: Strict["keyboard"] = {
    async down(key) {
      await page.keyboard.down(key);
      heldKeys.add(key);
    },
    async up(key) {
      await page.keyboard.up(key);
      heldKeys.delete(key);
    },
    async press(key) {
      await keyboard.down(key);
      await sleep(PRESS_MS);
      await keyboard.up(key);
    }
  };

  return {
    mouse,
    keyboard,
    async release() {
      await motion;
      for (const key of heldKeys) await keyboard.up(key);
      for (const button of heldButtons) await mouse.up(button);
    }
  };
}
