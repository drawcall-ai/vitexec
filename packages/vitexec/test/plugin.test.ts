import { afterEach, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import type { TestServer } from "./helpers.js";
import { createExampleServer, createTempViteServer } from "./helpers.js";
import {
  buildVitexecUrl,
  uploadCode,
  VITEXEC_CODE_ROUTE,
  VITEXEC_UPLOAD_ROUTE
} from "../src/index.js";

function serverUrl(path: string): string {
  if (!currentServer) {
    throw new Error("No current test server.");
  }

  return new URL(path, currentServer.url).toString();
}

let currentServer: TestServer | undefined;

afterEach(async () => {
  await currentServer?.close();
  currentServer = undefined;
});

describe("vitexec Vite plugin", () => {
  it("stores, retrieves, and isolates uploaded code by id", async () => {
    currentServer = await createTempViteServer({
      "index.html": '<script type="module" src="/src/main.js"></script>',
      "src/main.js": "console.log('app ready');"
    });

    await uploadCode(currentServer.url, "first", "console.log('first')");
    await uploadCode(currentServer.url, "second", "console.log('second')");

    const first = await fetch(serverUrl(`${VITEXEC_CODE_ROUTE}/first`));
    const second = await fetch(serverUrl(`${VITEXEC_CODE_ROUTE}/second`));
    const missing = await fetch(serverUrl(`${VITEXEC_CODE_ROUTE}/missing`));

    expect(first.status).toBe(200);
    expect(await first.text()).toBe("console.log('first')");
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("console.log('second')");
    expect(missing.status).toBe(404);
  });

  it("rejects non-POST requests to the upload route", async () => {
    currentServer = await createTempViteServer({
      "index.html": "<main>hello</main>"
    });

    const response = await fetch(serverUrl(`${VITEXEC_UPLOAD_ROUTE}/x`));

    expect(response.status).toBe(405);
  });

  it("loads uploaded ESM code when the load param is present", async () => {
    currentServer = await createTempViteServer({
      "index.html": '<script type="module" src="/src/main.js"></script>',
      "src/main.js": "console.log('app ready');"
    });
    await uploadCode(currentServer.url, "esm", "console.log('uploaded esm')");

    const browser = await chromium.launch();
    const logs: string[] = [];
    try {
      const page = await browser.newPage();
      page.on("console", (message) => logs.push(message.text()));
      await page.goto(buildVitexecUrl(currentServer.url, "esm"), {
        waitUntil: "networkidle"
      });
      await page.waitForFunction(
        () => window.__vitexecTestLogs?.includes("uploaded esm"),
        null,
        { timeout: 1_000 }
      ).catch(() => undefined);
    } finally {
      await browser.close();
    }

    expect(logs).toContain("uploaded esm");
  });

  it("lets injected code import example scene state and inspect camera space", async () => {
    currentServer = await createExampleServer();
    await uploadCode(
      currentServer.url,
      "three-check",
      `
        import { camera, cube, Vector3 } from "/src/scene-state.ts";
        camera.updateMatrixWorld();
        cube.updateMatrixWorld();
        const cameraSpace = cube.getWorldPosition(new Vector3()).applyMatrix4(camera.matrixWorldInverse);
        console.log("cube-camera-space", JSON.stringify({
          left: cameraSpace.x < 0,
          inFront: cameraSpace.z < 0
        }));
      `
    );

    const browser = await chromium.launch();
    const logs: string[] = [];
    try {
      const page = await browser.newPage();
      page.on("console", (message) => logs.push(message.text()));
      await page.goto(buildVitexecUrl(currentServer.url, "three-check"), {
        waitUntil: "networkidle"
      });
      await page.waitForFunction(
        () =>
          Array.from(document.querySelectorAll("canvas")).length === 1,
        null,
        { timeout: 2_000 }
      );
      await page.waitForTimeout(100);
    } finally {
      await browser.close();
    }

    expect(logs).toContain(
      'cube-camera-space {"left":true,"inFront":true}'
    );
  });
});
