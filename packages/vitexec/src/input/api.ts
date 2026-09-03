export type MouseButton = "left" | "middle" | "right";
export type DurationOptions = { durationMs?: number };
export type HoldOptions = { releaseAfterMs?: number };

export type InputCommand =
  | { type: "mouse.move"; deltaX: number; deltaY: number; durationMs?: number }
  | { type: "mouse.moveTo"; x: number; y: number; durationMs?: number }
  | { type: "mouse.moveLatest"; deltaX: number; deltaY: number }
  | { type: "mouse.moveToLatest"; x: number; y: number }
  | { type: "mouse.stop" }
  | { type: "mouse.down"; button: MouseButton; releaseAfterMs?: number }
  | { type: "mouse.up"; button: MouseButton }
  | { type: "mouse.click"; button: MouseButton; durationMs?: number }
  | { type: "keyboard.down"; key: string; releaseAfterMs?: number }
  | { type: "keyboard.up"; key: string }
  | { type: "keyboard.press"; key: string; durationMs?: number };

export const INPUT_BINDING = "__vitexecInput";

declare global {
  var __vitexecInput: ((command: InputCommand) => Promise<void>) | undefined;
}

function send(command: InputCommand): Promise<void> {
  const input = globalThis.__vitexecInput;
  if (!input) throw new Error("Vitexec input is unavailable outside a running Vitexec script.");
  return input(command);
}

export const mouse = {
  move: (deltaX: number, deltaY: number, options?: DurationOptions) =>
    send({ type: "mouse.move", deltaX, deltaY, durationMs: options?.durationMs }),
  moveTo: (x: number, y: number, options?: DurationOptions) =>
    send({ type: "mouse.moveTo", x, y, durationMs: options?.durationMs }),
  moveLatest: (deltaX: number, deltaY: number) =>
    send({ type: "mouse.moveLatest", deltaX, deltaY }),
  moveToLatest: (x: number, y: number) =>
    send({ type: "mouse.moveToLatest", x, y }),
  stop: () => send({ type: "mouse.stop" }),
  down: (button: MouseButton = "left", options?: HoldOptions) =>
    send({ type: "mouse.down", button, releaseAfterMs: options?.releaseAfterMs }),
  up: (button: MouseButton = "left") => send({ type: "mouse.up", button }),
  click: (button: MouseButton = "left", options?: DurationOptions) =>
    send({ type: "mouse.click", button, durationMs: options?.durationMs })
};

export const keyboard = {
  down: (key: string, options?: HoldOptions) =>
    send({ type: "keyboard.down", key, releaseAfterMs: options?.releaseAfterMs }),
  up: (key: string) => send({ type: "keyboard.up", key }),
  press: (key: string, options?: DurationOptions) =>
    send({ type: "keyboard.press", key, durationMs: options?.durationMs })
};
