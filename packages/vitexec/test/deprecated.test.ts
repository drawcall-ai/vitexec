import { expect, it, vi } from "vitest";
import { openPage } from "../src/page.js";
import { runVitexec } from "../src/deprecated.js";

vi.mock("../src/page.js", () => ({ openPage: vi.fn() }));
vi.mock("../src/run.js", () => ({ run: vi.fn() }));

it("surfaces cleanup failures when iteration ends during startup", async () => {
  const failure = new AggregateError([new Error("server cleanup failed")], "Failed to close the app.");
  vi.mocked(openPage).mockImplementation(async options => {
    options?.onLog?.("starting");
    return new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(failure), { once: true });
    });
  });

  const logs = runVitexec("");
  expect(await logs.next()).toEqual({ done: false, value: "starting" });
  await expect(logs.return()).rejects.toBe(failure);
});
