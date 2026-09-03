import { mouse } from "vitexec";

type Read<T> = () => T | undefined | null;

const waitFor = async <T>(read: Read<T>): Promise<T> => {
  for (let i = 0; i < 120; i += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error("Timed out waiting for captured mouse example");
};

const canvas = await waitFor(() => document.querySelector<HTMLCanvasElement>("[data-stage]"));
const api = await waitFor(() => window.capturedMouseControls);

api.reset();
const rect = canvas.getBoundingClientRect();
await mouse.moveTo(rect.x + rect.width / 2, rect.y + rect.height / 2);
await mouse.down();
await mouse.move(140, -32);
await mouse.up();
await new Promise((resolve) => requestAnimationFrame(resolve));

console.log("captured-mouse-turn", JSON.stringify({
  pointerLockElement: document.pointerLockElement === canvas,
  state: api.getState()
}));
