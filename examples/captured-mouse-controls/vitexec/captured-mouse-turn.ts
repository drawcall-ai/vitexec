type Read<T> = () => T | undefined | null;

export {};

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
canvas.dispatchEvent(new PointerEvent("pointerdown", {
  bubbles: true,
  button: 0,
  buttons: 1,
  pointerId: 1,
  pointerType: "mouse"
}));

const move = new MouseEvent("mousemove", { bubbles: true });
Object.defineProperty(move, "movementX", { value: 140 });
Object.defineProperty(move, "movementY", { value: -32 });
canvas.dispatchEvent(move);
await new Promise((resolve) => requestAnimationFrame(resolve));

console.log("captured-mouse-turn", JSON.stringify({
  pointerLockElement: document.pointerLockElement === canvas,
  state: api.getState()
}));
