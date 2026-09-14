import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { addOptions, createRunOptions } from "../src/cli/options.js";
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

it.each([undefined, true, false])("applies gpu=%s to local and remote launches", async gpu => {
  const stopped = new Error("launch intercepted");
  const launch = vi.spyOn(chromium, "launch").mockRejectedValue(stopped);
  const connect = vi.spyOn(chromium, "connect").mockRejectedValue(stopped);
  await expect(openBrowser({ gpu })).rejects.toBe(stopped);
  await expect(openBrowser({ gpu, browserWsEndpoint: "ws://localhost:1234" })).rejects.toBe(stopped);
  const local = launch.mock.calls[0]?.[0]?.args;
  const remote = JSON.parse(connect.mock.calls[0]?.[1]?.headers?.["x-playwright-launch-options"] ?? "{}").args;
  expect(remote).toEqual(local);
  expect(local).toContain(gpu === false ? "--disable-gpu" : "--enable-gpu");
  expect(local).not.toContain(gpu === false ? "--enable-gpu" : "--disable-gpu");
});

it("lets --no-gpu override the environment without hiding environment defaults", () => {
  const parse = (args: string[], env: Record<string, string>) => {
    const command = addOptions(new Command(), "once").exitOverride().parse(args, { from: "user" });
    return createRunOptions(command.opts(), { env }).gpu;
  };
  expect(parse([], {})).toBeUndefined();
  expect(parse([], { VITEXEC_GPU: "false" })).toBe(false);
  expect(parse(["--no-gpu"], { VITEXEC_GPU: "true" })).toBe(false);
});
