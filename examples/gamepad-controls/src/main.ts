import "./style.css";

type GamepadSnapshot = {
  actionPressed: boolean;
  connected: boolean;
  x: number;
  y: number;
};

declare global {
  interface Window {
    gamepadControls?: {
      getSnapshot: () => GamepadSnapshot;
    };
  }
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app element.");
}

app.innerHTML = `
  <section class="pad-shell">
    <div data-stick class="stick"></div>
    <output data-readout>waiting</output>
  </section>
`;

const stickElement = app.querySelector<HTMLDivElement>("[data-stick]");
const readoutElement = app.querySelector<HTMLOutputElement>("[data-readout]");

if (!stickElement || !readoutElement) {
  throw new Error("Gamepad UI failed to initialize.");
}

const stick = stickElement;
const readout = readoutElement;

const state: GamepadSnapshot = {
  actionPressed: false,
  connected: false,
  x: 0,
  y: 0
};

function update(): void {
  const gamepad = navigator.getGamepads().find(Boolean);
  state.connected = Boolean(gamepad);
  state.x = gamepad?.axes[0] ?? 0;
  state.y = gamepad?.axes[1] ?? 0;
  state.actionPressed = Boolean(gamepad?.buttons[0]?.pressed);

  stick.style.transform = `translate(${state.x * 90}px, ${state.y * 90}px)`;
  stick.dataset.pressed = String(state.actionPressed);
  readout.value = JSON.stringify(state);
  requestAnimationFrame(update);
}

window.gamepadControls = {
  getSnapshot: () => ({ ...state })
};

update();
