import { afterEach, describe, expect, it } from "vitest";
import { observe } from "../src/observe/browser.js";
import { installObservationProvider } from "../src/observe/host.js";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
});

function install(snapshot: () => string): void {
  dispose = installObservationProvider({ snapshot });
}

describe("Vitexec observation", () => {
  it("fails visibly without a trusted provider", () => {
    expect(() => observe()).toThrow("no trusted read-only provider is installed");
  });

  it("returns a readable serialized snapshot for discovery", () => {
    install(() => JSON.stringify({ ready: true, count: 2 }));
    expect(observe()).toBe(`{
  "ready": true,
  "count": 2
}`);
  });

  it("selects validated primitive fields into an inert record", () => {
    install(() => JSON.stringify({ session: { ready: true, count: 2 } }));
    const result = observe({
      ready: { kind: "boolean", path: ["session", "ready"] },
      count: { kind: "number", path: ["session", "count"] }
    });
    expect(result).toEqual({ ready: true, count: 2 });
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("supports explicit nullable and optional primitive fields", () => {
    install(() => JSON.stringify({ value: null }));
    expect(observe({
      value: { kind: "string", nullable: true, path: ["value"] },
      missing: {
        kind: "number",
        nullable: true,
        optional: true,
        path: ["missing"]
      }
    })).toEqual({ value: null, missing: null });
  });

  it("rejects wrong paths, containers, kinds, and non-finite numbers", () => {
    install(() => '{"nested":null,"text":"ready","infinite":1e400}');
    expect(() => observe({
      value: { kind: "string", path: ["nested", "value"] }
    })).toThrow("encountered null");
    expect(() => observe({
      value: { kind: "number", path: ["text"] }
    })).toThrow("expected number, received string");
    expect(() => observe({
      value: { kind: "number", path: ["infinite"] }
    })).toThrow("must be finite");
  });

  it("rejects invalid projection shapes and unsafe keys", () => {
    install(() => "{}");
    expect(() => observe({})).toThrow("must contain 1-32 fields");
    expect(() => observe({
      value: { kind: "number", optional: true, path: ["value"] }
    })).toThrow("optional requires nullable: true");
    expect(() => observe({
      value: { kind: "number", path: ["__proto__"] }
    })).toThrow("safe property name");
  });

  it("rejects invalid snapshots and provider shapes", () => {
    expect(() => Reflect.apply(installObservationProvider, undefined, [{}]))
      .toThrow("must contain a snapshot function");
    install(() => "not json");
    expect(() => observe()).toThrow("returned invalid JSON");
  });

  it("preserves the provider receiver and lifecycle", () => {
    const provider = {
      value: 3,
      snapshot() {
        return JSON.stringify({ value: this.value });
      }
    };
    dispose = installObservationProvider(provider);
    expect(observe({ value: { kind: "number", path: ["value"] } }).value).toBe(3);
    expect(() => installObservationProvider(provider))
      .toThrow("already installed");
    dispose();
    dispose = undefined;
    expect(() => observe()).toThrow("no trusted read-only provider is installed");
  });
});
