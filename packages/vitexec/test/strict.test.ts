import { afterEach, describe, expect, it } from "vitest";
import type { TestProject } from "./helpers.js";
import { createTempViteProject } from "./helpers.js";
import { runVitexec } from "../src/cli.js";
import { compileStrictScript } from "../src/strict/script.js";
import { MOUSE_EVENT_HZ, MOUSE_SPEED_PX_PER_S } from "../src/strict/input.js";

let project: TestProject | undefined;

afterEach(async () => {
  await project?.close();
  project = undefined;
});

const APP = {
  "index.html": `<canvas id="stage" width="400" height="300"></canvas>
<script type="module">
  import { store } from "/src/store.js";
  window.app = { score: 1, pos: { x: 1, y: 2 }, list: [{ id: 1 }, { id: 2 }], setScore(v) { this.score = v; } };
  window.events = [];
  const push = (label) => window.events.push(label);
  document.addEventListener("mousemove", (e) => push("move:" + e.clientX + "," + e.clientY + ":" + e.isTrusted));
  document.addEventListener("mousedown", (e) => push("down:" + e.button));
  document.addEventListener("mouseup", (e) => push("up:" + e.button));
  document.addEventListener("keydown", (e) => push("keydown:" + e.code + ":" + e.isTrusted));
  document.addEventListener("keyup", (e) => push("keyup:" + e.code));
  window.store = store;
</script>`,
  "src/store.js": "export const store = { items: ['a', 'b'], size() { return this.items.length; } };"
};

async function runStrict(code: string): Promise<string> {
  const lines: string[] = [];
  for await (const line of runVitexec(code, { configFile: false, root: project?.root, strict: true })) {
    lines.push(line);
  }
  return lines.join("\n");
}

describe("strict mode", () => {
  it("observes app state and DOM read-only, and rejects writes", async () => {
    project = await createTempViteProject(APP);
    const output = await runStrict(`
      console.log("score", await observe(() => window.app.score));
      console.log("ids", JSON.stringify(await observe((key) => window.app.list.map((item) => item[key]), "id")));
      console.log("canvas", await observe(() => document.querySelector("#stage").getBoundingClientRect().width));
      for (const write of [
        () => { window.app.score = 9; },
        () => window.app.setScore(9),
        () => window.app.list.push({ id: 3 }),
        () => setTimeout(() => { window.app.score = 9; }, 0),
        () => document.body.append(document.createElement("div"))
      ]) {
        await observe(write).then(() => console.log("allowed", String(write)), (error) => console.log(error.message.split(";")[0]));
      }
      console.log("score after", await observe(() => window.app.score));
    `);
    expect(output).toContain("[log] score 1");
    expect(output).toContain("[log] ids [1,2]");
    expect(output).toContain("[log] canvas 400");
    expect(output).not.toContain("allowed");
    expect(output.match(/observe\(\) must be read-only/g)).toHaveLength(5);
    expect(output).toContain("[log] score after 1");
  });

  it("reads page modules through load()", async () => {
    project = await createTempViteProject(APP);
    const output = await runStrict(`
      const store = await load("/src/store.js");
      console.log("size", await observe((m) => m.store.size(), store));
      await load("/src/missing.js").catch((error) => console.log("missing", error.message.includes("/src/missing.js")));
    `);
    expect(output).toContain("[log] size 2");
    expect(output).toContain("[log] missing true");
  });

  it("terminates an observe() that never returns", async () => {
    project = await createTempViteProject(APP);
    const output = await runStrict(`
      await observe(() => { while (true) {} }).catch((error) => console.log(error.message));
      console.log("still", await observe(() => window.app.score));
    `);
    expect(output).toContain("ran longer than");
    expect(output).toContain("[log] still 1");
  });

  it("delivers paced trusted pointer paths and releases held input", async () => {
    project = await createTempViteProject(APP);
    const output = await runStrict(`
      await mouse.moveTo(100, 100);
      const started = performance.now();
      await mouse.move(600, 0);
      console.log("elapsed", Math.round(performance.now() - started));
      console.log("position", JSON.stringify(mouse.position));
      await mouse.click();
      await keyboard.press("KeyW");
      await keyboard.down("KeyA");
      await mouse.down("right");
      await sleep(50);
      console.log("events", JSON.stringify(await observe(() => window.events)));
    `);
    const expectedMs = 600 / MOUSE_SPEED_PX_PER_S * 1000;
    const elapsed = Number(/elapsed (\d+)/.exec(output)?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(expectedMs * 0.9);
    expect(elapsed).toBeLessThan(expectedMs * 3);
    expect(output).toContain('[log] position {"x":700,"y":100}');

    const events = JSON.parse(/events (\[.*\])/.exec(output)?.[1] ?? "[]") as string[];
    const moves = events.filter((event) => event.startsWith("move:"));
    expect(moves.length).toBeGreaterThanOrEqual(Math.floor(600 / MOUSE_SPEED_PX_PER_S * MOUSE_EVENT_HZ));
    expect(moves.every((event) => event.endsWith(":true"))).toBe(true);
    // Held input is released only after the script finishes, so the script's
    // own event dump sees the holds still open.
    expect(events).toEqual(expect.arrayContaining([
      "down:0", "up:0", "keydown:KeyW:true", "keyup:KeyW", "keydown:KeyA:true", "down:2"
    ]));
    expect(events).not.toContain("keyup:KeyA");
    expect(events).not.toContain("up:2");
  });

  it("reports script errors and rejects other imports", async () => {
    project = await createTempViteProject(APP);
    const output = await runStrict('import { observe } from "vitexec/strict";\nthrow new Error("boom");');
    expect(output).toContain("[error] Error: boom");
    await expect(compileStrictScript('import { x } from "/src/store.js";')).rejects.toThrow(
      /may only import from "vitexec\/strict"/
    );
  });

  it("strips TypeScript and the strict import", async () => {
    const script = await compileStrictScript(`
      import type { Strict } from "vitexec/strict";
      import { sleep } from "vitexec/strict";
      const value: number = 1;
      await sleep(0);
      console.log(value satisfies number);
      export {};
    `);
    const logs: string[] = [];
    const fakeConsole = { log: (...values: unknown[]) => logs.push(values.join(" ")) } as Console;
    await script({ sleep: async () => undefined } as never, fakeConsole);
    expect(logs).toEqual(["1"]);
  });
});
