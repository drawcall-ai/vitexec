import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { input } from "../src/input/browser.js";
import { parseInputCommand } from "../src/input/parse.js";
import {
  installPlaywrightInput,
  PlaywrightInputDriver,
  type PlaywrightInputLimits
} from "../src/input/playwright.js";

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser.close();
});

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await run(page);
  } finally {
    if (!page.isClosed()) await page.close();
  }
}

const fastLimits: PlaywrightInputLimits = {
  eventIntervalMs: 5,
  maximumDurationMs: 500,
  maximumSpeedPixelsPerSecond: 10_000,
  minimumDurationMs: 20
};

describe("Vitexec input", () => {
  it("parses public commands and rejects removed or malformed commands", () => {
    expect(parseInputCommand({
      type: "mouse.moveLatest",
      deltaX: 2,
      deltaY: -1
    })).toEqual({ type: "mouse.moveLatest", deltaX: 2, deltaY: -1 });
    expect(() => parseInputCommand({ type: "mouse.repeat" }))
      .toThrow("Unsupported Vitexec input command: mouse.repeat");
    expect(() => parseInputCommand({
      type: "keyboard.down",
      key: "w",
      durationMs: 20
    })).toThrow("Unexpected Vitexec input field: durationMs");
    expect(() => parseInputCommand({ type: "wait", durationMs: 0 }))
      .toThrow('field "durationMs" must be positive');
  });

  it("keeps browser waits local and fails visibly without a host", async () => {
    let calls = 0;
    vi.stubGlobal("__vitexecInput_v1__", async () => {
      calls += 1;
      return { status: "completed" };
    });
    await expect(input({ type: "wait", durationMs: 1 }))
      .resolves.toEqual({ status: "completed" });
    expect(calls).toBe(0);
    vi.unstubAllGlobals();

    await expect(input({ type: "keyboard.down", key: "x" })).rejects.toThrow(
      "no trusted Playwright input host is installed"
    );
  });

  it("delivers keyboard and click commands through real Playwright input", async () => {
    await withPage(async (page) => {
      const driver = await installPlaywrightInput(page);
      await page.setContent(`
        <button id="target">Target</button>
        <script>
          globalThis.events = [];
          addEventListener("keydown", event => events.push(event.type + ":" + event.key));
          addEventListener("keyup", event => events.push(event.type + ":" + event.key));
          addEventListener("click", event => events.push(event.type + ":" + event.target.id));
        </script>
      `);

      await driver.run({ type: "keyboard.press", key: "x", durationMs: 20 });
      await driver.run({ type: "mouse.click", target: "#target" });
      await driver.run({ type: "mouse.click", x: 1, y: 1 });

      expect(await page.evaluate(() => globalThis.events)).toEqual([
        "keydown:x",
        "keyup:x",
        "click:target",
        "click:"
      ]);
      await driver.finishRun();
    });
  });

  it("renews bounded holds without emitting another edge", async () => {
    await withPage(async (page) => {
      const driver = new PlaywrightInputDriver(page, fastLimits);
      await page.setContent(`
        <script>
          globalThis.events = [];
          addEventListener("keydown", event => events.push(event.type + ":" + event.key));
          addEventListener("keyup", event => events.push(event.type + ":" + event.key));
        </script>
      `);

      const first = await driver.run({
        type: "keyboard.down",
        key: "w",
        releaseAfterMs: 60
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const renewed = await driver.run({
        type: "keyboard.down",
        key: "w",
        releaseAfterMs: 60
      });
      await new Promise((resolve) => setTimeout(resolve, 70));

      expect(first).toMatchObject({ status: "held", edgeEmitted: true });
      expect(renewed).toMatchObject({ status: "held", edgeEmitted: false });
      expect(await page.evaluate(() => globalThis.events)).toEqual([
        "keydown:w",
        "keyup:w"
      ]);
      await driver.finishRun();
    });
  });

  it("rejects one-shot edges on held controls and preserves the hold", async () => {
    await withPage(async (page) => {
      const driver = new PlaywrightInputDriver(page, fastLimits);
      await driver.run({ type: "mouse.down", button: "left" });

      await expect(driver.run({
        type: "mouse.press",
        button: "left",
        durationMs: 20
      })).rejects.toThrow("cannot press held left mouse button");
      await expect(driver.run({
        type: "mouse.click",
        x: 10,
        y: 10,
        button: "left"
      })).rejects.toThrow("cannot click held left mouse button");

      await driver.run({ type: "mouse.up", button: "left" });
      await driver.finishRun();
    });
  });

  it("rejects host duration violations before emitting an edge", async () => {
    await withPage(async (page) => {
      const driver = new PlaywrightInputDriver(page, fastLimits);
      await expect(driver.run({
        type: "keyboard.down",
        key: "w",
        releaseAfterMs: 501
      })).rejects.toThrow("exceeds the host maximum 500ms");
      await expect(driver.run({
        type: "mouse.press",
        durationMs: 501
      })).rejects.toThrow("exceeds the host maximum 500ms");
      await driver.finishRun();
    });
  });

  it("settles fixed movement and rejects overlapping movement", async () => {
    await withPage(async (page) => {
      const driver = new PlaywrightInputDriver(page, fastLimits);
      await page.setContent(`
        <script>
          globalThis.moves = [];
          addEventListener("mousemove", event => moves.push([event.clientX, event.clientY]));
        </script>
      `);

      const first = driver.run({
        type: "mouse.moveTo",
        x: 40,
        y: 20,
        durationMs: 30
      });
      await expect(driver.run({
        type: "mouse.move",
        deltaX: 1,
        deltaY: 0,
        durationMs: 20
      })).rejects.toThrow("another pointer movement is active");
      await expect(first).resolves.toEqual({ status: "completed" });

      const moves = await page.evaluate(() => globalThis.moves);
      expect(moves.length).toBeGreaterThan(1);
      expect(moves.at(-1)).toEqual([40, 20]);
      await driver.finishRun();
    });
  });

  it("starts, replaces, and stops latest pointer movement", async () => {
    await withPage(async (page) => {
      const driver = new PlaywrightInputDriver(page, fastLimits);
      await page.setContent(`
        <script>
          globalThis.moves = [];
          addEventListener("mousemove", event => moves.push([event.clientX, event.clientY]));
        </script>
      `);

      await expect(driver.run({
        type: "mouse.moveLatest",
        deltaX: 20,
        deltaY: 0
      })).resolves.toEqual({ status: "latest.started", leaseMs: 400 });
      await expect(driver.run({
        type: "mouse.moveLatest",
        deltaX: -5,
        deltaY: 2
      })).resolves.toEqual({ status: "latest.started", leaseMs: 400 });
      await expect(driver.run({ type: "mouse.stop" }))
        .resolves.toEqual({ status: "completed" });

      const moves = await page.evaluate(() => globalThis.moves);
      expect(moves.length).toBeGreaterThanOrEqual(2);
      await driver.finishRun();
    });
  });

  it("keeps button transitions independent from latest movement", async () => {
    await withPage(async (page) => {
      const driver = new PlaywrightInputDriver(page, fastLimits);
      await driver.run({ type: "mouse.moveLatest", x: 100, y: 0 });
      await driver.run({ type: "mouse.down", button: "left" });
      await driver.run({ type: "mouse.up", button: "left" });
      await driver.run({ type: "mouse.stop" });
      await driver.finishRun();
    });
  });

  it("cleans up held input and latest movement", async () => {
    await withPage(async (page) => {
      const driver = new PlaywrightInputDriver(page, fastLimits);
      await page.setContent(`
        <script>
          globalThis.events = [];
          addEventListener("keyup", event => events.push(event.type + ":" + event.key));
          addEventListener("mouseup", event => events.push(event.type + ":" + event.button));
        </script>
      `);
      await driver.run({ type: "keyboard.down", key: "w" });
      await driver.run({ type: "mouse.down", button: "left" });
      await driver.run({ type: "mouse.moveLatest", x: 100, y: 0 });
      await driver.finishRun();

      expect(await page.evaluate(() => globalThis.events)).toEqual([
        "keyup:w",
        "mouseup:0"
      ]);
    });
  });

  it("surfaces background movement failures on the next boundary", async () => {
    const page = await browser.newPage();
    const driver = new PlaywrightInputDriver(page, fastLimits);
    await driver.run({ type: "mouse.moveLatest", x: 100, y: 0 });
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(driver.run({ type: "keyboard.up", key: "w" })).rejects.toThrow();
  });
});
