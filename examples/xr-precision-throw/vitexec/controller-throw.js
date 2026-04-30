// Replays the XR precision throw with IWER installed from vitexec, not from the app.
//
// From this package:
//   pnpm vitexec:controller
//
// From the repo root:
//   pnpm --filter xr-precision-throw vitexec:controller

import { XRDevice, metaQuest3 } from "iwer";

const device = new XRDevice(metaQuest3);
device.installRuntime({ globalObject: window, polyfillLayers: true });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const vec = ([x, y, z]) => ({ x, y, z });

async function waitForApp() {
  const started = performance.now();

  while (!window.xrPrecisionThrow) {
    if (performance.now() - started > 5000) {
      throw new Error("Timed out waiting for xrPrecisionThrow.");
    }
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }

  return window.xrPrecisionThrow;
}

async function lookAtBall(api) {
  await device.remote.dispatch("look_at", {
    device: "headset",
    target: vec(api.getBallPosition()),
  });
}

async function setController(position, target = [0, 1.75, -8.5]) {
  await device.remote.dispatch("set_transform", {
    device: "controller-right",
    position: vec(position),
  });
  await device.remote.dispatch("look_at", {
    device: "controller-right",
    target: vec(target),
  });
}

await nextFrame();
await nextFrame();

const api = await waitForApp();

await api.store.enterVR();
await device.remote.dispatch("set_input_mode", { mode: "controller" });
await device.remote.dispatch("set_connected", {
  device: "controller-right",
  connected: true,
});
await device.remote.dispatch("set_transform", {
  device: "headset",
  position: { x: 0, y: 1.6, z: 1.3 },
});

api.reset();
await wait(500);
await lookAtBall(api);
await setController([0, 1.25, -0.75], api.getBallPosition());
await wait(400);

console.log("before", api.getStatus(), JSON.stringify(api.getBallPosition()));

await device.remote.dispatch("set_select_value", {
  device: "controller-right",
  value: 1,
});
await wait(350);
await lookAtBall(api);

console.log("grab", api.getStatus(), JSON.stringify(api.getBallPosition()));

await setController([0, 1.35, -1.1]);
await wait(80);
await lookAtBall(api);

await setController([0, 2.0, -1.7]);
await wait(35);
await lookAtBall(api);

await device.remote.dispatch("set_select_value", {
  device: "controller-right",
  value: 0,
});

for (let i = 0; i < 26; i += 1) {
  await lookAtBall(api);
  await wait(100);
}

console.log("final", api.getStatus(), api.getHitCount(), JSON.stringify(api.getBallPosition()));
