type Read<T> = () => T | undefined | null;

export {};

const waitFor = async <T>(read: Read<T>): Promise<T> => {
  for (let i = 0; i < 120; i += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error("Timed out waiting for mouse target");
};

const target = await waitFor(() => document.querySelector<HTMLButtonElement>("[data-target]"));
const api = await waitFor(() => window.mouseClickTarget);
const rect = target.getBoundingClientRect();
const clientX = Math.round(rect.left + rect.width / 2);
const clientY = Math.round(rect.top + rect.height / 2);

target.dispatchEvent(new PointerEvent("pointerdown", {
  bubbles: true,
  button: 0,
  buttons: 1,
  clientX,
  clientY,
  pointerId: 1,
  pointerType: "mouse"
}));
target.dispatchEvent(new PointerEvent("pointerup", {
  bubbles: true,
  button: 0,
  buttons: 0,
  clientX,
  clientY,
  pointerId: 1,
  pointerType: "mouse"
}));
target.dispatchEvent(new MouseEvent("click", {
  bubbles: true,
  button: 0,
  clientX,
  clientY
}));
await new Promise((resolve) => requestAnimationFrame(resolve));

console.log("mouse-click-target", JSON.stringify(api.getSnapshot()));
