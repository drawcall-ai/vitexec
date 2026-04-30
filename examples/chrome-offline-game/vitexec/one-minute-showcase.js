const waitFor = async (read) => {
  for (let i = 0; i < 120; i += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  throw new Error("Timed out waiting for game");
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const game = await waitFor(() => window.chromeOfflineGame);
game.reset();

const started = performance.now();
const jumped = new WeakSet();
let collisions = 0;
let ducks = 0;
let jumps = 0;

const originalCollides = game.collides.bind(game);
game.collides = (obstacle) => {
  const hit = originalCollides(obstacle);
  if (hit) collisions += 1;
  return hit;
};

const play = setInterval(() => {
  const state = game.getSnapshot();
  if (state.gameOver) return;

  const dinoY = game.dinoY ?? 0;
  const obstacles = (game.obstacles ?? [])
    .filter((obstacle) => obstacle.x + obstacle.width > 80)
    .sort((a, b) => a.x - b.x);

  const shouldDuck =
    dinoY === 0 &&
    obstacles.some(
      (obstacle) =>
        obstacle.kind === "bird" &&
        obstacle.x < 270 &&
        obstacle.x + obstacle.width > 78
    );

  game.setDucking(shouldDuck);
  if (shouldDuck) {
    ducks += 1;
    return;
  }

  for (const obstacle of obstacles) {
    const distance = obstacle.x - 152;
    const lead = Math.max(155, state.speed * 205);
    if (
      obstacle.kind === "cactus" &&
      dinoY === 0 &&
      distance < lead &&
      distance > 12 &&
      !jumped.has(obstacle)
    ) {
      game.jump();
      jumped.add(obstacle);
      jumps += 1;
      break;
    }
  }
}, 8);

await wait(60_000);
clearInterval(play);
game.setDucking(false);

console.log(
  "one-minute-showcase",
  JSON.stringify({
    ...game.getSnapshot(),
    collisions,
    ducks,
    elapsedMs: Math.round(performance.now() - started),
    jumps
  })
);
