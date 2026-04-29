import { OfflineRunnerGame } from "./game";
import type { GameSnapshot } from "./game";
import "./style.css";

declare global {
  interface Window {
    chromeOfflineGame?: OfflineRunnerGame;
  }
}

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app element.");
}

app.innerHTML = `
  <section class="game-shell">
    <header class="status-bar">
      <div class="scoreboard" aria-live="polite">
        <div>
          <p class="score-label">Score</p>
          <div class="score-value" data-score>0</div>
        </div>
        <div>
          <p class="score-label">Best</p>
          <div class="score-value" data-best>0</div>
        </div>
      </div>
      <div class="game-actions">
        <button class="icon-button" type="button" data-pause aria-label="Pause or resume" title="Pause or resume">||</button>
        <button class="icon-button" type="button" data-reset aria-label="Restart" title="Restart">↻</button>
      </div>
    </header>
    <div class="stage-wrap">
      <canvas data-stage aria-label="Chrome offline runner game"></canvas>
    </div>
  </section>
`;

const canvas = app.querySelector<HTMLCanvasElement>("[data-stage]");
const score = app.querySelector<HTMLElement>("[data-score]");
const best = app.querySelector<HTMLElement>("[data-best]");
const pause = app.querySelector<HTMLButtonElement>("[data-pause]");
const reset = app.querySelector<HTMLButtonElement>("[data-reset]");

if (!canvas || !score || !best || !pause || !reset) {
  throw new Error("Game UI failed to initialize.");
}

const scoreElement = score;
const bestElement = best;
const pauseButton = pause;

function renderStats(snapshot: GameSnapshot): void {
  scoreElement.textContent = String(snapshot.score).padStart(5, "0");
  bestElement.textContent = String(snapshot.best).padStart(5, "0");
  pauseButton.textContent = snapshot.isPaused ? ">" : "||";
}

export const game = new OfflineRunnerGame(canvas, renderStats);
window.chromeOfflineGame = game;

pause.addEventListener("click", () => game.togglePause());
reset.addEventListener("click", () => game.reset());

window.addEventListener("resize", () => game.resize());
window.addEventListener("keydown", (event) => {
  if (event.code === "Space" || event.code === "ArrowUp") {
    event.preventDefault();
    game.jump();
  }
  if (event.code === "ArrowDown") game.setDucking(true);
  if (event.code === "KeyP") game.togglePause();
});
window.addEventListener("keyup", (event) => {
  if (event.code === "ArrowDown") game.setDucking(false);
});

canvas.addEventListener("pointerdown", () => game.jump());

game.start();
