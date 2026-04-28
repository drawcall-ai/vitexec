import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestServer } from "./helpers.js";
import { createExampleServer, createTempViteServer } from "./helpers.js";
import { runVitexec, VITEXEC_TIMEOUT_MS } from "../src/cli.js";

let currentServer: TestServer | undefined;
let currentTempDir: string | undefined;

afterEach(async () => {
  await currentServer?.close();
  if (currentTempDir) await rm(currentTempDir, { recursive: true, force: true });
  currentServer = undefined;
  currentTempDir = undefined;
});

describe("vitexec CLI runner", () => {
  it("returns browser logs for injected code", async () => {
    currentServer = await createTempViteServer({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(currentServer.url, "console.log('loaded')");

    expect(output).toContain("[log] loaded");
  });

  it("captures runtime errors from injected code", async () => {
    currentServer = await createTempViteServer({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      currentServer.url,
      "throw new Error('injected failure')"
    );

    expect(output).toContain("injected failure");
  });

  it("can run a richer imported Three.js assertion against the example", async () => {
    currentServer = await createExampleServer();

    const output = await runVitexec(
      currentServer.url,
      `
        import { camera, cube, Vector3 } from "/src/scene-state.ts";
        const position = cube.getWorldPosition(new Vector3()).applyMatrix4(camera.matrixWorldInverse);
        console.log("front-left", position.z < 0 && position.x < 0);
      `
    );

    expect(output).toContain("[log] front-left true");
  });

  it("can write a screenshot after injected code runs", async () => {
    currentServer = await createTempViteServer({
      "index.html": "<main>ready</main>"
    });
    currentTempDir = await mkdtemp(join(tmpdir(), "vitexec-shot-"));
    const screenshotPath = join(currentTempDir, "nested", "page.png");

    const output = await runVitexec(
      currentServer.url,
      "document.body.style.background = 'rgb(255, 0, 0)'",
      { screenshotPath }
    );

    expect(output).toContain(`[screenshot] ${screenshotPath}`);
    expect((await stat(screenshotPath)).size).toBeGreaterThan(0);
  });

  it("can launch with gpu-friendly new headless mode", async () => {
    currentServer = await createTempViteServer({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      currentServer.url,
      "console.log('gpu mode')",
      { gpu: true }
    );

    expect(output).toContain("[log] gpu mode");
  });

  it("reports failed resource loads with URL and status", async () => {
    currentServer = await createTempViteServer({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      currentServer.url,
      "await fetch('/__vitexec/code/missing'); console.log('ready')"
    );

    expect(output).toContain("[http 404] GET");
    expect(output).toContain("/__vitexec/code/missing");
    expect(output).not.toContain("Failed to load resource");
  });

  it("uses a 10 minute timeout and logs timeout errors", async () => {
    expect(VITEXEC_TIMEOUT_MS).toBe(10 * 60 * 1000);

    currentServer = await createTempViteServer({
      "index.html": "<main>ready</main>"
    });

    const output = await runVitexec(
      currentServer.url,
      "console.log('too slow')",
      { timeoutMs: 1 }
    );

    expect(output).toContain("[error] timeout after 1ms");
  });
});
