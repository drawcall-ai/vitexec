import { describe, expect, it } from "vitest";
import { assertStrictSource, verifyStrictSource } from "../src/strict/verify.js";

function issueCodes(source: string): string[] {
  return verifyStrictSource(source).issues.map((issue) => issue.code);
}

describe("strict source verifier", () => {
  it("formats structured issues when assertion is required", () => {
    expect(() => assertStrictSource("window.app.mutate()"))
      .toThrow("Strict source verification failed: external-call at 1:1");
  });

  it("accepts the documented observe, compute, log, and input subset", () => {
    const result = verifyStrictSource(`
      import { input, observe } from "vitexec";

      const app = observe({
        ready: { kind: "boolean", path: ["state", "ready"] },
        first: { kind: "string", path: ["items", 0] }
      });
      const ready = app.ready;
      const base = 20;
      const total = base + 2;
      let label = "waiting";
      if (ready === true) label = "ready";

      const report = {
        first: app.first,
        label,
        ready,
        total
      };
      console.log(report);
      await input({ type: "mouse.click", target: "#start" });
      await input({
        type: "mouse.moveLatest",
        deltaX: 8,
        deltaY: -2
      });
      await input({ type: "mouse.down", button: "left" });
    `);

    expect(result).toEqual({ issues: [], ok: true });
  });

  it("rejects host transport and indirect commands", () => {
    expect(issueCodes(`
      import { input } from "vitexec";
      let command = await input({ type: "host.receive" });
      while (command.type !== "host.stop") {
        const result = await input(command);
        command = await input({ type: "host.receive", result });
      }
    `)).toContain("escape-hatch");

    expect(issueCodes(`
      import { input } from "vitexec";
      const command = { type: "keyboard.up", key: "x" };
      await input(command);
    `)).toContain("external-call");
  });

  it.each([
    ["keyboard", `await input({ type: "keyboard.down", key: "w", durationMs: 100 });`],
    ["mouse", `await input({ type: "mouse.down", button: "left", durationMs: 100 });`]
  ])("preflights an invalid literal %s hold", (_name, command) => {
    const result = verifyStrictSource(`
      import { input } from "vitexec";
      ${command}
    `);

    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "external-call",
        message: "Unexpected Vitexec input field: durationMs"
      })
    ]);
  });

  it("preflights a valid literal hold", () => {
    expect(issueCodes(`
      import { input } from "vitexec";
      await input({ type: "keyboard.down", key: "w", releaseAfterMs: 100 });
      await input({ type: "mouse.down", button: "left", releaseAfterMs: 100 });
    `)).toEqual([]);
  });

  it("requires physical input to be awaited", () => {
    expect(issueCodes(`
      import { input } from "vitexec";
      input({ type: "keyboard.up", key: "w" });
    `)).toContain("external-call");
  });

  it("leaves dynamic literal fields to runtime validation", () => {
    expect(issueCodes(`
      import { input, observe } from "vitexec";
      const durationMs = observe({
        value: { kind: "number", path: ["holdDuration"] }
      }).value;
      await input({ type: "keyboard.down", key: "w", durationMs });
    `)).toEqual([]);
  });

  it("accepts a resident input loop over projected primitive observations", () => {
    const result = verifyStrictSource(`
      import { input, observe } from "vitexec";

      let active = true;
      while (active) {
        const match = observe({
          over: { kind: "boolean", path: ["match", "over"] }
        });
        if (match.over === true) {
          active = false;
        } else {
          const interaction = observe({
            pointerX: { kind: "number", path: ["interaction", "pointerX"] },
            pointerY: { kind: "number", path: ["interaction", "pointerY"] },
            visible: { kind: "boolean", path: ["interaction", "visible"] },
            width: { kind: "number", path: ["viewport", "width"] }
          });
          const errorX = interaction.pointerX - interaction.width / 2;
          const selectedError = errorX;
          const rawVelocity = selectedError * 10;
          const velocity = rawVelocity > 1200
            ? 1200
            : rawVelocity < -1200 ? -1200 : rawVelocity;
          const aligned = errorX > -1 && errorX < 1 && interaction.visible === true;
          await input({
            type: "mouse.moveLatest",
            deltaX: velocity / 10,
            deltaY: interaction.pointerY - 360
          });
          if (aligned) {
            await input({
              type: "mouse.press",
              button: "left",
              durationMs: 80
            });
          }
        }
      }
    `);

    expect(result).toEqual({ issues: [], ok: true });
  });

  it("accepts passive trusted observation schema discovery", () => {
    expect(issueCodes(`
      import { observe } from "vitexec";
      console.log(observe());
    `)).toEqual([]);
  });

  it("accepts multiple syntax-proven primitive console values", () => {
    expect(issueCodes(`
      import { observe } from "vitexec";
      const state = observe({
        ready: { kind: "boolean", path: ["session", "ready"] },
        count: { kind: "number", path: ["session", "count"] }
      });
      console.log("state", state.ready, state.count);
    `)).toEqual([]);
  });

  it("returns structured parse issues with source locations", () => {
    const result = verifyStrictSource("const value: = 1;");

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatchObject({
      code: "parse-error",
      start: { column: 14, line: 1 }
    });
  });

  it("parses JavaScript according to the requested language", () => {
    const result = verifyStrictSource("const value: string = 'typed';", {
      language: "javascript"
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("parse-error");
  });

  it.each([
    ["default import", `import input from "vitexec"; input();`],
    ["aliased import", `import { input as drive } from "vitexec"; drive();`],
    ["aliased observe", `import { observe as sample } from "vitexec"; sample({});`],
    ["additional import", `import { input, run } from "vitexec"; input();`],
    ["type-only import", `import type { input } from "vitexec";`],
    ["other module", `import { input } from "./input.js"; input();`],
    ["input member call", `import { input } from "vitexec"; input.click();`],
    ["input alias call", `import { input } from "vitexec"; const run = input; run();`]
  ])("rejects the unapproved input shape: %s", (_name, source) => {
    expect(verifyStrictSource(source).ok).toBe(false);
  });

  it.each([
    ["awaited projection", `import { observe } from "vitexec"; await observe({ value: { kind: "number", path: ["value"] } });`],
    ["dynamic projection", `import { observe } from "vitexec"; const path = window.app.path; observe(path);`],
    ["dynamic path", `import { observe } from "vitexec"; observe({ value: { kind: "number", path: window.app.path } });`],
    ["unsafe path", `import { observe } from "vitexec"; observe({ value: { kind: "number", path: ["constructor"] } });`],
    ["unknown kind", `import { observe } from "vitexec"; observe({ value: { kind: "object", path: ["value"] } });`],
    ["dynamic nullable", `import { observe } from "vitexec"; observe({ value: { kind: "number", nullable: window.app.nullable, path: ["value"] } });`],
    ["dynamic optional", `import { observe } from "vitexec"; observe({ value: { kind: "number", nullable: true, optional: window.app.optional, path: ["value"] } });`],
    ["optional without nullable", `import { observe } from "vitexec"; observe({ value: { kind: "number", optional: true, path: ["value"] } });`],
    ["additional field", `import { observe } from "vitexec"; observe({ value: { kind: "number", path: ["value"], fallback: 0 } });`]
  ])("rejects an unprovable observation projection: %s", (_name, source) => {
    expect(verifyStrictSource(source).ok).toBe(false);
  });

  it("keeps application reads behind the observation provider", () => {
    expect(issueCodes(`window.app.value;`)).toContain("external-call");
    expect(issueCodes(`
      import { observe } from "vitexec";
      const sample = observe({ value: { kind: "number", path: ["value"] } });
      sample.value + 1;
    `)).toEqual([]);
  });

  it.each([
    ["property assignment", `window.app.ready = true;`],
    ["property update", `window.app.version++;`],
    ["property deletion", `delete globalThis.app.store;`],
    ["aliased property", `const state = window.app.state; state.ready = true;`],
    ["array length", `const values = [1]; values.length = window.app.value;`],
    ["typed-array element", `const values = new Uint8Array(1); values[0] = window.app.value;`],
    ["URL property", `const url = new URL("https://example.test"); url.href = window.app.value;`],
    ["dynamic property", `const local = {}; local[window.app.key] = window.app.state;`],
    ["method installation", `const values = [1]; values.map = window.app.mutate;`],
    ["computed method installation", `const values = [1]; values["m" + "ap"] = window.app.mutate;`],
    ["assignment destructuring", `let value; [window.app.state] = [value];`],
    ["ambient write", `declare let liveFlag: number; liveFlag = 1;`]
  ])("rejects writes outside direct local-variable assignment: %s", (_name, source) => {
    expect(verifyStrictSource(source).ok).toBe(false);
  });

  it.each([
    ["application call", `window.app.store.setState({ ready: true });`],
    ["extracted application call", `const setState = window.app.setState; setState({});`],
    ["DOM-like application call", `window.app.querySelector("mutate");`],
    ["array iterator", `[1].map((value) => value);`],
    ["external callback", `[1].forEach(window.app.mutate);`],
    ["Number coercion", `Number(window.app.value);`],
    ["asserted coercion", `Number(window.app.value as number);`],
    ["annotated array coercion", `const value: string = [window.app.value] as unknown as string; String(value);`],
    ["JSON serialization", `JSON.stringify({ toJSON: window.app.mutate });`],
    ["Map construction", `new Map(window.app.iterable);`],
    ["typed-array construction", `new Uint8Array([window.app.value]);`],
    ["URLSearchParams construction", `new URLSearchParams({ value: window.app.value });`],
    ["array flattening", `const values = [window.app.proxy]; values.flat();`],
    ["console table", `console.table(window.app.proxy);`],
    ["console dir", `console.dir(window.app.proxy);`],
    ["formatted console output", `console.log("value: %s", window.app.value);`],
    ["tagged template", `window.app.tag\`value\`;`]
  ])("rejects non-approved execution: %s", (_name, source) => {
    expect(verifyStrictSource(source).ok).toBe(false);
  });

  it.each([
    ["await", `await window.app.thenable;`],
    ["local thenable", `const value = { then: window.app.mutate }; await value;`],
    ["for-of", `for (const value of window.app.iterable) console.log(value);`],
    ["for-in", `for (const key in window.app.proxy) console.log(key);`],
    ["for-await", `for await (const value of [window.app.thenable]) console.log(value);`],
    ["array spread", `const values = [...window.app.iterable];`],
    ["object spread", `const value = { ...window.app.proxy };`],
    ["array destructuring", `const [value] = window.app.iterable;`],
    ["nested destructuring", `const [[value]] = [window.app.iterable];`],
    ["object-rest destructuring", `const { ...value } = window.app.proxy;`],
    ["interpolated template", "`${window.app.value}`;"],
    ["dynamic read", `console.log(window.app[window.app.key]);`],
    ["computed definition", `const value = { [window.app.key]: 1 };`],
    ["in operator", `"ready" in window.app.proxy;`],
    ["instanceof", `window.app.value instanceof window.app.Type;`],
    ["compound assignment", `let value = 1; value += 1;`],
    ["update", `let value = 1; value++;`]
  ])("rejects implicit execution syntax: %s", (_name, source) => {
    expect(verifyStrictSource(source).ok).toBe(false);
  });

  it.each([
    ["function", `function run() { return 1; }`],
    ["arrow", `const run = () => 1;`],
    ["class", `class Value {}`],
    ["decorator", `@window.app.decorate class Value {}`],
    ["getter", `const value = { get then() { return window.app.mutate; } };`],
    ["enum", `enum Value { Item = window.app.value as number }`],
    ["namespace", `namespace Value { export const item = 1; }`],
    ["interface", `interface Value { item: number }`],
    ["type alias", `type Value = { item: number };`],
    ["resource declaration", `using value = window.app.resource;`]
  ])("rejects unsupported transformed or declaration syntax: %s", (_name, source) => {
    expect(verifyStrictSource(source).ok).toBe(false);
  });

  it("rejects JSX categorically", () => {
    const result = verifyStrictSource(`<div ready />;`, {
      language: "typescript"
    });

    expect(result.ok).toBe(false);
  });

  it.each([
    ["eval", `eval("window.app.ready = true")`],
    ["Function call", `Function("window.app.ready = true")()`],
    ["Function construction", `new Function("window.app.ready = true")()`],
    ["constructor chain", `window.app.value.constructor.constructor("return 1")()`],
    ["static import", `import { mutate } from "./app.js"; mutate();`],
    ["dynamic import", `await import("./app.js");`],
    ["export", `export const value = 1;`]
  ])("reports the escape hatch: %s", (_name, source) => {
    expect(issueCodes(source)).toContain("escape-hatch");
  });

  it("rejects coercive computation over an application read", () => {
    expect(issueCodes(`window.app.value + 1;`)).toContain("external-call");
  });

  it("rejects calls through a source-local console binding", () => {
    expect(issueCodes(`
      const console = window.app.console;
      console.log(window.app.state);
    `)).toContain("external-call");
  });
});
