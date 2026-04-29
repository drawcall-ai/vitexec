import "./style.css";

type ClickSnapshot = {
  clicks: number;
  lastX: number;
  lastY: number;
};

declare global {
  interface Window {
    mouseClickTarget?: {
      getSnapshot: () => ClickSnapshot;
    };
  }
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app element.");
}

app.innerHTML = `
  <section class="target-shell">
    <button data-target type="button">0</button>
    <p data-position>none</p>
  </section>
`;

const target = app.querySelector<HTMLButtonElement>("[data-target]");
const position = app.querySelector<HTMLParagraphElement>("[data-position]");

if (!target || !position) {
  throw new Error("Mouse target failed to initialize.");
}

const state: ClickSnapshot = {
  clicks: 0,
  lastX: 0,
  lastY: 0
};

target.addEventListener("click", (event) => {
  state.clicks += 1;
  state.lastX = event.clientX;
  state.lastY = event.clientY;
  target.textContent = String(state.clicks);
  position.textContent = `${state.lastX}, ${state.lastY}`;
});

window.mouseClickTarget = {
  getSnapshot: () => ({ ...state })
};
