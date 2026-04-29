type Read<T> = () => T | undefined | null;

export {};

const waitFor = async <T>(read: Read<T>): Promise<T> => {
  for (let i = 0; i < 120; i += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error("Timed out waiting for gamepad controls");
};

const button = (pressed = false, value = pressed ? 1 : 0): GamepadButton => ({
  pressed,
  touched: pressed,
  value
});

const gamepad = {
  axes: [0.65, -0.35, 0, 0],
  buttons: [button(true), button(false)],
  connected: true,
  id: "vitexec virtual gamepad",
  index: 0,
  mapping: "standard",
  timestamp: performance.now()
} as unknown as Gamepad;

Object.defineProperty(navigator, "getGamepads", {
  configurable: true,
  value: () => [gamepad]
});

const api = await waitFor(() => window.gamepadControls);
const connected = new Event("gamepadconnected");
Object.defineProperty(connected, "gamepad", { value: gamepad });
window.dispatchEvent(connected);
await new Promise((resolve) => requestAnimationFrame(resolve));
await new Promise((resolve) => requestAnimationFrame(resolve));

console.log("gamepad-controls", JSON.stringify(api.getSnapshot()));
