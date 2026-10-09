import { describe, expect, it } from "vitest";
import { formatError, withCleanup } from "../src/errors.js";

describe("error reporting", () => {
  it("shows nested cleanup failures and causes", () => {
    const error = new AggregateError([
      new Error("execution failed", { cause: new Error("script origin") }),
      new AggregateError([new Error("disk full"), "plain failure"], "capture failed")
    ], "cleanup failed");
    expect(formatError(error)).toBe([
      "cleanup failed", "  execution failed", "    script origin",
      "  capture failed", "    disk full", "    plain failure"
    ].join("\n"));
  });

  it("bounds circular causes without hiding other failures", () => {
    const error = new Error("root");
    error.cause = error;
    expect(formatError(new AggregateError([error, new Error("other")], "failed"))).toBe(
      "failed\n  root\n    [circular error]\n  other"
    );
  });
});

describe("cleanup error preservation", () => {
  it("runs cleanup and preserves the action error", async () => {
    const error = new Error("script failed");
    let closed = false;
    await expect(withCleanup(async () => { throw error; }, async () => { closed = true; }, "failed")).rejects.toBe(error);
    expect(closed).toBe(true);
  });

  it("preserves both failures including a thrown undefined", async () => {
    const error = new Error("close failed");
    try {
      await withCleanup(async () => { throw undefined; }, async () => { throw error; }, "both failed");
      throw new Error("Expected rejection.");
    } catch (failure) {
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw failure;
      expect(failure.errors).toEqual([undefined, error]);
      expect(failure.message).toBe("both failed");
    }
  });

  it("surfaces cleanup failure after a successful action", async () => {
    const error = new Error("close failed");
    await expect(withCleanup(async () => 42, async () => { throw error; }, "failed")).rejects.toBe(error);
  });

  it("returns the successful action's value after cleanup", async () => {
    expect(await withCleanup(async () => 42, async () => {}, "failed")).toBe(42);
  });
});
