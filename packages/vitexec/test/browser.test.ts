import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { addOptions, createRunOptions } from "../src/cli/options.js";
import { chromium } from "playwright";
import { createRemoteBrowserHeaders, openBrowser } from "../src/browser.js";

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

it.each([
  [undefined, undefined, undefined],
  [true, true, true],
  [false, false, false],
  [true, true, false],
  [true, false, true]
])("launches locally and remotely with gpu=%s, audioOutput=%s, audio=%s", async (gpu, audioOutput, audio) => {
  const stopped = new Error("launch intercepted");
  const launch = vi.spyOn(chromium, "launch").mockRejectedValue(stopped);
  const connect = vi.spyOn(chromium, "connect").mockRejectedValue(stopped);
  const options = { gpu, audioOutput, audio, timeoutMs: 1234 };
  await expect(openBrowser(options)).rejects.toBe(stopped);
  await expect(openBrowser({ ...options, browserWsEndpoint: "ws://localhost:1234" })).rejects.toBe(stopped);
  const local = launch.mock.calls[0]?.[0];
  const remote: unknown = JSON.parse(connect.mock.calls[0]?.[1]?.headers?.["x-playwright-launch-options"] ?? "{}");
  expect(remote).toMatchObject({ args: local?.args, timeout: 1234 });
  expect(local?.timeout).toBe(1234);
  expect(connect.mock.calls[0]?.[1]?.timeout).toBe(1234);
  expect(local?.args).toContain(gpu === false ? "--disable-gpu" : "--enable-gpu");
  expect(local?.args).not.toContain(gpu === false ? "--enable-gpu" : "--disable-gpu");
  expect(local?.args?.includes("--disable-audio-output")).toBe(audioOutput !== true);
  expect(local?.ignoreDefaultArgs).toEqual(audio === false ? undefined : ["--mute-audio"]);
  if (audio === false) expect(remote).not.toHaveProperty("ignoreDefaultArgs");
  else expect(remote).toMatchObject({ ignoreDefaultArgs: ["--mute-audio"] });
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

it.each(["open", "once"] as const)("parses audio output flags and environment for %s", scope => {
  const parse = (args: string[], env: Record<string, string>) => {
    const command = addOptions(new Command(), scope).exitOverride().parse(args, { from: "user" });
    return createRunOptions(command.opts(), { env }).audioOutput;
  };
  expect(parse([], {})).toBeUndefined();
  expect(parse([], { VITEXEC_AUDIO_OUTPUT: "true" })).toBe(true);
  expect(parse([], { VITEXEC_AUDIO_OUTPUT: "false" })).toBe(false);
  expect(parse(["--audio-output"], { VITEXEC_AUDIO_OUTPUT: "false" })).toBe(true);
  expect(parse(["--no-audio-output"], { VITEXEC_AUDIO_OUTPUT: "true" })).toBe(false);
});

it("enables remote speaker output without requiring a recording", () => {
  const headers = createRemoteBrowserHeaders({ audioOutput: true });
  const launchOptions: unknown = JSON.parse(headers["x-playwright-launch-options"] ?? "{}");
  expect(launchOptions).toMatchObject({ ignoreDefaultArgs: ["--mute-audio"] });
  expect(launchOptions).toHaveProperty("args", expect.not.arrayContaining(["--disable-audio-output"]));
});
