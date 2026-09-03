import { mouse } from "vitexec";

type Read<T> = () => T | undefined | null;

const waitFor = async <T>(read: Read<T>): Promise<T> => {
  for (let i = 0; i < 120; i += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error("Timed out waiting for canvas game");
};

const canvas = await waitFor(() => document.querySelector<HTMLCanvasElement>("[data-stage]"));
const game = await waitFor(() => window.canvasPositionClickGame);
const { target } = game.getSnapshot();
const rect = canvas.getBoundingClientRect();
const clientX = rect.left + (target.x / canvas.clientWidth) * rect.width;
const clientY = rect.top + (target.y / canvas.clientHeight) * rect.height;

await mouse.moveTo(clientX, clientY);
await mouse.click();
await new Promise((resolve) => requestAnimationFrame(resolve));

console.log("canvas-position-click-game", JSON.stringify(game.getSnapshot()));
