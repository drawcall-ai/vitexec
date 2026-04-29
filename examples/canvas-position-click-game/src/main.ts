import "./style.css";

type Target = {
  radius: number;
  x: number;
  y: number;
};

type GameSnapshot = {
  hits: number;
  lastClick?: {
    hit: boolean;
    x: number;
    y: number;
  };
  target: Target;
};

declare global {
  interface Window {
    canvasPositionClickGame?: {
      getSnapshot: () => GameSnapshot;
    };
  }
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app element.");
}

app.innerHTML = `
  <section class="game-shell">
    <canvas data-stage aria-label="Canvas target game"></canvas>
    <output data-score>hits 0</output>
  </section>
`;

const canvasElement = app.querySelector<HTMLCanvasElement>("[data-stage]");
const scoreElement = app.querySelector<HTMLOutputElement>("[data-score]");
const context = canvasElement?.getContext("2d");

if (!canvasElement || !scoreElement || !context) {
  throw new Error("Canvas target game failed to initialize.");
}

const canvas = canvasElement;
const score = scoreElement;
const ctx = context;
const target: Target = {
  radius: 34,
  x: 420,
  y: 190
};

let hits = 0;
let lastClick: GameSnapshot["lastClick"];

function resize(): void {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(canvas.clientWidth * ratio);
  canvas.height = Math.floor(canvas.clientHeight * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}

function canvasPointFromEvent(event: MouseEvent | PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.clientWidth,
    y: ((event.clientY - rect.top) / rect.height) * canvas.clientHeight
  };
}

function isInsideTarget(point: { x: number; y: number }): boolean {
  return Math.hypot(point.x - target.x, point.y - target.y) <= target.radius;
}

function draw(): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#15222b";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "#334957";
  ctx.lineWidth = 1;
  for (let x = 40; x < width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 40; y < height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  ctx.fillStyle = "#f2c14e";
  ctx.beginPath();
  ctx.arc(target.x, target.y, target.radius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(target.x, target.y, target.radius + 6, 0, Math.PI * 2);
  ctx.stroke();

  if (lastClick) {
    ctx.fillStyle = lastClick.hit ? "#56d364" : "#ff5c5c";
    ctx.beginPath();
    ctx.arc(lastClick.x, lastClick.y, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  score.value = `hits ${hits}`;
}

canvas.addEventListener("click", (event) => {
  const point = canvasPointFromEvent(event);
  const hit = isInsideTarget(point);
  lastClick = {
    hit,
    x: Number(point.x.toFixed(1)),
    y: Number(point.y.toFixed(1))
  };
  if (hit) hits += 1;
  draw();
});

window.addEventListener("resize", resize);
window.canvasPositionClickGame = {
  getSnapshot: () => ({
    hits,
    lastClick,
    target: { ...target }
  })
};

resize();
