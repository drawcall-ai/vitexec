import "./style.css";

type CapturedMouseState = {
  captured: boolean;
  moves: number;
  pitch: number;
  yaw: number;
};

declare global {
  interface Window {
    capturedMouseControls?: {
      getState: () => CapturedMouseState;
      reset: () => void;
    };
  }
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app element.");
}

app.innerHTML = `
  <section class="mouse-stage">
    <canvas data-stage aria-label="Captured mouse camera"></canvas>
  </section>
`;

const canvasElement = app.querySelector<HTMLCanvasElement>("[data-stage]");
const canvasContext = canvasElement?.getContext("2d");

if (!canvasElement || !canvasContext) {
  throw new Error("Captured mouse canvas failed to initialize.");
}

const canvas = canvasElement;
const context = canvasContext;

const state: CapturedMouseState = {
  captured: false,
  moves: 0,
  pitch: 0,
  yaw: 0
};

function resize(): void {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(640, Math.floor(canvas.clientWidth));
  const height = Math.max(360, Math.floor(canvas.clientHeight));
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}

function turn(movementX: number, movementY: number): void {
  state.moves += 1;
  state.yaw += movementX * 0.08;
  state.pitch = Math.max(-55, Math.min(55, state.pitch - movementY * 0.08));
  draw();
}

function draw(): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#111418";
  context.fillRect(0, 0, width, height);

  const horizon = height / 2 + state.pitch * 2;
  context.fillStyle = "#273443";
  context.fillRect(0, horizon, width, height - horizon);
  context.strokeStyle = "#5fd4ff";
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(width / 2 - 72, height / 2);
  context.lineTo(width / 2 + 72, height / 2);
  context.moveTo(width / 2, height / 2 - 72);
  context.lineTo(width / 2, height / 2 + 72);
  context.stroke();

  context.fillStyle = "#f3f7fb";
  context.font = "16px ui-sans-serif, system-ui";
  context.fillText(`yaw ${state.yaw.toFixed(1)}`, 24, 34);
  context.fillText(`pitch ${state.pitch.toFixed(1)}`, 24, 58);
  context.fillText(`moves ${state.moves}`, 24, 82);
}

canvas.tabIndex = 0;
canvas.addEventListener("pointerdown", () => {
  state.captured = true;
  canvas.focus();
  void canvas.requestPointerLock?.().catch(() => undefined);
});
window.addEventListener("pointerup", () => {
  state.captured = false;
});
canvas.addEventListener("mousemove", (event) => {
  if (state.captured || document.pointerLockElement === canvas) {
    turn(event.movementX, event.movementY);
  }
});
window.addEventListener("resize", resize);

window.capturedMouseControls = {
  getState: () => ({ ...state }),
  reset: () => {
    state.captured = false;
    state.moves = 0;
    state.pitch = 0;
    state.yaw = 0;
    draw();
  }
};

resize();
