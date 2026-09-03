import { chromium, type Page } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { runVitexec } from "../src/cli.js";
import {
  MOUSE_EVENT_HZ,
  MOUSE_SPEED_PX_PER_S
} from "../src/input/playwright.js";
import type { TestProject } from "./helpers.js";
import { createTempViteProject } from "./helpers.js";

let project: TestProject | undefined;

afterEach(async () => {
  await project?.close();
  project = undefined;
});

const APP = {
  "index.html": `<canvas id="stage" width="400" height="300"></canvas>
<script>
  window.events = [];
  const push = (label) => {
    window.events.push(label);
    document.body.dataset.events = window.events.join(";");
  };
  document.addEventListener("mousemove", (event) => push("move:" + event.movementX + "," + event.movementY + ":" + event.isTrusted));
  document.addEventListener("mousedown", (event) => push("down:" + event.button));
  document.addEventListener("mouseup", (event) => push("up:" + event.button));
  document.addEventListener("click", (event) => push("click:" + event.isTrusted));
  document.addEventListener("keydown", (event) => push("keydown:" + event.code + ":" + event.isTrusted));
  document.addEventListener("keyup", (event) => push("keyup:" + event.code));
</script>`
};

async function run(code: string, page?: Page): Promise<string> {
  const lines: string[] = [];
  for await (const line of runVitexec(code, { configFile: false, page, root: project?.root })) {
    lines.push(line);
  }
  return lines.join("\n");
}

function eventsFrom(output: string): string[] {
  const events: unknown = JSON.parse(/events (\[.*\])/.exec(output)?.[1] ?? "[]");
  if (!Array.isArray(events) || events.some((event) => typeof event !== "string")) {
    throw new Error("Expected string input events.");
  }
  return events;
}

describe("human input", () => {
  it("delivers smooth trusted pointer paths and physical key edges", async () => {
    project = await createTempViteProject(APP);
    const output = await run(`
      import { keyboard, mouse } from "vitexec";
      await mouse.moveTo(100, 100);
      window.events.length = 0;
      const started = performance.now();
      await mouse.move(600, 0, { durationMs: 100 });
      console.log("elapsed", Math.round(performance.now() - started));
      await mouse.click("left", { durationMs: 80 });
      await keyboard.press("KeyW", { durationMs: 80 });
      console.log("events", JSON.stringify(window.events));
    `);

    const expectedMs = 1.5 * 600 / MOUSE_SPEED_PX_PER_S * 1000;
    const elapsed = Number(/elapsed (\d+)/.exec(output)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(expectedMs * 0.9);
    expect(elapsed).toBeLessThan(expectedMs * 3);

    const events = eventsFrom(output);
    const moves = events.filter((event) => event.startsWith("move:"));
    const moveSteps = Math.ceil(expectedMs * MOUSE_EVENT_HZ / 1000);
    expect(moves.length).toBeGreaterThanOrEqual(moveSteps);
    expect(moves.every((event) => event.endsWith(":true"))).toBe(true);
    const deltas = moves.slice(-moveSteps).map((event) => Number(/move:([^,]+)/.exec(event)?.[1]));
    expect(Math.abs(deltas[0])).toBeLessThan(Math.max(...deltas.map(Math.abs)));
    expect(Math.abs(deltas.at(-1) ?? 0)).toBeLessThan(Math.max(...deltas.map(Math.abs)));
    expect(events).toEqual(expect.arrayContaining([
      "down:0",
      "up:0",
      "click:true",
      "keydown:KeyW:true",
      "keyup:KeyW"
    ]));
  });

  it("replaces adaptive pointer movement without teleporting", async () => {
    project = await createTempViteProject(APP);
    const output = await run(`
      import { mouse } from "vitexec";
      await mouse.moveTo(100, 100);
      window.events.length = 0;
      await mouse.moveLatest(600, 0);
      await new Promise((resolve) => setTimeout(resolve, 70));
      await mouse.moveLatest(-600, 0);
      await new Promise((resolve) => setTimeout(resolve, 70));
      await mouse.stop();
      console.log("events", JSON.stringify(window.events));
    `);

    const deltas = eventsFrom(output)
      .filter((event) => event.startsWith("move:"))
      .map((event) => Number(/move:([^,]+)/.exec(event)?.[1]));
    expect(deltas.length).toBeGreaterThan(4);
    expect(deltas.some((delta) => delta > 0)).toBe(true);
    expect(deltas.some((delta) => delta < 0)).toBe(true);
  });

  it("turns a non-zero subpixel relative move into physical input", async () => {
    project = await createTempViteProject(APP);
    const output = await run(`
      import { mouse } from "vitexec";
      await mouse.moveTo(100, 100);
      window.events.length = 0;
      await mouse.move(0.25, -0.25);
      console.log("events", JSON.stringify(window.events));
      try {
        await mouse.move(Number.NaN, 0);
      } catch (error) {
        console.log("invalid", error instanceof Error ? error.message : String(error));
      }
    `);

    const movement = eventsFrom(output)
      .filter((event) => event.startsWith("move:"))
      .map((event) => event.match(/move:([^,]+),([^:]+)/)?.slice(1).map(Number) ?? [0, 0]);
    expect(movement.reduce((sum, [x]) => sum + x, 0)).toBe(1);
    expect(movement.reduce((sum, [, y]) => sum + y, 0)).toBe(-1);
    expect(output).toContain("invalid Vitexec mouse coordinates must be finite numbers.");
  });

  it("allows long holds and releases leased and unfinished controls", async () => {
    project = await createTempViteProject(APP);
    const browser = await chromium.launch({ channel: "chromium" });
    const page = await browser.newPage();
    try {
      const output = await run(`
        import { keyboard, mouse } from "vitexec";
        await keyboard.down("KeyW", { releaseAfterMs: 40 });
        await new Promise((resolve) => setTimeout(resolve, 80));
        console.log("events", JSON.stringify(window.events));
        await keyboard.down("KeyD", { releaseAfterMs: 2_000 });
        await keyboard.up("KeyD");
        await keyboard.down("KeyA");
        await mouse.down("right");
      `, page);

      expect(eventsFrom(output)).toContain("keyup:KeyW");
      const events = await page.locator("body").getAttribute("data-events");
      expect(events).toContain("keyup:KeyA");
      expect(events).toContain("up:2");
    } finally {
      await browser.close();
    }
  });
});
