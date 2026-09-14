import { afterEach, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { openBrowser } from "../src/browser.js";

afterEach(() => vi.restoreAllMocks());

it.each([undefined, true, false])("forwards headless=%s to local launches", async headless => {
  const stopped = new Error("launch intercepted");
  const launch = vi.spyOn(chromium, "launch").mockRejectedValue(stopped);
  await expect(openBrowser({ headless })).rejects.toBe(stopped);
  expect(launch).toHaveBeenCalledWith(expect.objectContaining({ headless: headless ?? true }));
});

it("forwards visible launch options to a remote endpoint", async () => {
  const stopped = new Error("connect intercepted");
  const connect = vi.spyOn(chromium, "connect").mockRejectedValue(stopped);
  await expect(openBrowser({ browserWsEndpoint: "ws://localhost:1234", headless: false })).rejects.toBe(stopped);
  const options = connect.mock.calls[0]?.[1];
  expect(JSON.parse(options?.headers?.["x-playwright-launch-options"] ?? "{}")).toMatchObject({ headless: false });
});
