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
  it("preserves both failures including a thrown undefined", async () => {
    const error = new Error("close failed");
    await expect(withCleanup(async () => { throw undefined; }, async () => { throw error; }, "both failed"))
      .rejects.toMatchObject({ message: "both failed", errors: [undefined, error] });
  });

  it("surfaces cleanup failure after a successful action", async () => {
    const error = new Error("close failed");
    await expect(withCleanup(async () => 42, async () => { throw error; }, "failed")).rejects.toBe(error);
  });

});
