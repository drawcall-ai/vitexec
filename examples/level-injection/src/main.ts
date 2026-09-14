import "./style.css";

function element(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node;
}

let level = 1;
let moves = 0;
let hits = 0;
let deliveries = 0;
let x = 0;
let y = 1;
let drag: { x: number; y: number } | undefined;

export function getState() {
  return { level, moves, hits, deliveries };
}

function render() {
  ["walk", "aim", "deliver", "won"].forEach((id, index) => {
    element(id).hidden = level !== index + 1;
  });
  element("arrows").hidden = level !== 1;
  element("title").textContent = ["Walk around the wall.", "Hit the targets in order.", "Deliver the parcel.", "Nicely done."][level - 1];
  element("hint").textContent = [
    "Use the arrow keys to reach the green exit.",
    "Click 1, then 2, then 3. A wrong target does not count.",
    "Drag the red box into the green dock.",
    "You walked, aimed, and delivered. All in one game."
  ][level - 1];
  element("score").textContent = `${moves} moves · ${hits} targets · ${deliveries} ${deliveries === 1 ? "delivery" : "deliveries"}`;
  element("player").style.gridArea = `${y + 1} / ${x + 1}`;
  document.querySelectorAll("#progress li").forEach((item, index) => {
    item.classList.toggle("complete", index + 1 < level);
    if (index + 1 === level) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
}

function move(key: string) {
  if (level !== 1) return;
  const directions: Record<string, [number, number]> = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
  };
  const delta = directions[key];
  if (!delta) return;
  const nextX = x + delta[0];
  const nextY = y + delta[1];
  if (nextX < 0 || nextX > 4 || nextY < 0 || nextY > 2 || (nextX === 2 && nextY === 1)) return;
  x = nextX;
  y = nextY;
  moves++;
  if (x === 4 && y === 1) level = 2;
  render();
}

document.addEventListener("keydown", event => {
  if (level !== 1 || !event.key.startsWith("Arrow")) return;
  event.preventDefault();
  move(event.key);
});
document.querySelectorAll<HTMLButtonElement>("[data-key]").forEach(button => {
  button.addEventListener("click", () => move(button.dataset.key ?? ""));
});
document.querySelectorAll<HTMLButtonElement>("[data-target]").forEach(button => {
  button.addEventListener("click", () => {
    if (level !== 2 || Number(button.dataset.target) !== hits + 1) return;
    hits++;
    button.disabled = true;
    if (hits === 3) level = 3;
    render();
  });
});

const parcel = element("parcel");
parcel.addEventListener("pointerdown", event => {
  if (level !== 3 || event.button !== 0) return;
  drag = { x: event.clientX, y: event.clientY };
  parcel.setPointerCapture(event.pointerId);
});
parcel.addEventListener("pointermove", event => {
  if (drag) parcel.style.transform = `translate(${event.clientX - drag.x}px, ${event.clientY - drag.y}px)`;
});
parcel.addEventListener("pointerup", event => {
  if (!drag) return;
  const dock = element("dock").getBoundingClientRect();
  if (event.clientX >= dock.left && event.clientX <= dock.right && event.clientY >= dock.top && event.clientY <= dock.bottom) {
    deliveries++;
    level = 4;
  }
  drag = undefined;
  parcel.style.transform = "";
  render();
});
parcel.addEventListener("pointercancel", () => {
  drag = undefined;
  parcel.style.transform = "";
});
element("restart").addEventListener("click", () => location.reload());
render();
