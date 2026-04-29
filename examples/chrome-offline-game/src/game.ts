export type GameSnapshot = {
  best: number;
  gameOver: boolean;
  isDucking: boolean;
  isPaused: boolean;
  score: number;
  speed: number;
};

type Obstacle = {
  height: number;
  kind: "cactus" | "bird";
  passed: boolean;
  width: number;
  x: number;
  y: number;
};

const gravity = 0.00215;
const jumpVelocity = -0.82;
const groundPadding = 86;
const dinoX = 104;

export class OfflineRunnerGame {
  private best = 0;
  private ctx: CanvasRenderingContext2D;
  private dinoY = 0;
  private frameHandle = 0;
  private gameOver = false;
  private groundY = 0;
  private isDucking = false;
  private isPaused = false;
  private lastTime = 0;
  private nextSpawnMs = 850;
  private obstacles: Obstacle[] = [];
  private score = 0;
  private speed = 0.42;
  private velocityY = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onChange: (snapshot: GameSnapshot) => void
  ) {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D is unavailable.");
    this.ctx = context;
    this.resize();
    this.reset();
  }

  getSnapshot(): GameSnapshot {
    return {
      best: Math.floor(this.best),
      gameOver: this.gameOver,
      isDucking: this.isDucking,
      isPaused: this.isPaused,
      score: Math.floor(this.score),
      speed: Number(this.speed.toFixed(2))
    };
  }

  jump(): void {
    if (this.gameOver) {
      this.reset();
      return;
    }
    if (this.isPaused || this.dinoY !== 0) return;

    this.velocityY = jumpVelocity;
  }

  setDucking(value: boolean): void {
    this.isDucking = value && !this.gameOver && this.dinoY === 0;
  }

  togglePause(): void {
    if (this.gameOver) return;
    this.isPaused = !this.isPaused;
    this.emit();
  }

  reset(): void {
    this.dinoY = 0;
    this.gameOver = false;
    this.isDucking = false;
    this.isPaused = false;
    this.nextSpawnMs = 700;
    this.obstacles = [];
    this.score = 0;
    this.speed = 0.42;
    this.velocityY = 0;
    this.emit();
  }

  resize(): void {
    const width = Math.max(640, Math.floor(this.canvas.clientWidth));
    const height = Math.max(360, Math.floor(this.canvas.clientHeight));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.floor(width * ratio);
    this.canvas.height = Math.floor(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.groundY = height - groundPadding;
  }

  start(): void {
    this.lastTime = performance.now();
    const tick = (time: number): void => {
      const delta = Math.min(time - this.lastTime, 32);
      this.lastTime = time;
      this.update(delta);
      this.draw();
      this.frameHandle = requestAnimationFrame(tick);
    };
    this.frameHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frameHandle);
  }

  private update(delta: number): void {
    if (this.isPaused || this.gameOver) return;

    this.score += delta * 0.018;
    this.speed = Math.min(0.82, 0.42 + this.score / 1200);
    this.nextSpawnMs -= delta;

    this.velocityY += gravity * delta;
    this.dinoY = Math.min(0, this.dinoY + this.velocityY * delta);
    if (this.dinoY === 0) this.velocityY = 0;

    if (this.nextSpawnMs <= 0) {
      this.spawnObstacle();
      this.nextSpawnMs = this.getNextSpawnDelay();
    }

    for (const obstacle of this.obstacles) {
      obstacle.x -= this.speed * delta;
      if (!obstacle.passed && obstacle.x + obstacle.width < dinoX) {
        obstacle.passed = true;
        this.score += 8;
      }
    }

    this.obstacles = this.obstacles.filter((obstacle) => obstacle.x > -90);

    if (this.obstacles.some((obstacle) => this.collides(obstacle))) {
      this.gameOver = true;
      this.best = Math.max(this.best, this.score);
      this.emit();
    } else {
      this.emit();
    }
  }

  private spawnObstacle(): void {
    const width = Math.random() > 0.7 ? 54 : 34;
    const height = Math.random() > 0.78 ? 48 : 64;
    const kind = Math.random() > 0.78 && this.score > 90 ? "bird" : "cactus";
    const y = kind === "bird" ? this.groundY - 118 : this.groundY - height;

    this.obstacles.push({
      height,
      kind,
      passed: false,
      width,
      x: this.canvas.clientWidth + 30,
      y
    });
  }

  private getNextSpawnDelay(): number {
    const speedPressure = this.speed * 60;
    return 1_520 + Math.random() * 560 - speedPressure;
  }

  private collides(obstacle: Obstacle): boolean {
    const dino = {
      height: this.isDucking ? 42 : 72,
      width: this.isDucking ? 72 : 48,
      x: dinoX,
      y: this.groundY - (this.isDucking ? 42 : 72) + this.dinoY
    };

    return (
      dino.x < obstacle.x + obstacle.width &&
      dino.x + dino.width > obstacle.x &&
      dino.y < obstacle.y + obstacle.height &&
      dino.y + dino.height > obstacle.y
    );
  }

  private draw(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.ctx.clearRect(0, 0, width, height);
    this.drawSky(width, height);
    this.drawGround(width);
    this.drawDino();
    for (const obstacle of this.obstacles) this.drawObstacle(obstacle);
    if (this.gameOver || this.isPaused) this.drawOverlay(width, height);
  }

  private drawSky(width: number, height: number): void {
    const gradient = this.ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#fdfbf4");
    gradient.addColorStop(1, "#eaf3f6");
    this.ctx.fillStyle = gradient;
    this.ctx.fillRect(0, 0, width, height);

    this.ctx.fillStyle = "#f4d35e";
    this.ctx.beginPath();
    this.ctx.arc(width - 110, 78, 26, 0, Math.PI * 2);
    this.ctx.fill();

    this.ctx.fillStyle = "#d8e2dc";
    for (let i = 0; i < 4; i += 1) {
      const x = ((this.score * -4 + i * 230) % (width + 180)) + 30;
      this.ctx.fillRect(x, 92 + i * 18, 78, 8);
      this.ctx.fillRect(x + 22, 78 + i * 18, 42, 8);
    }
  }

  private drawGround(width: number): void {
    this.ctx.strokeStyle = "#5f6f52";
    this.ctx.lineWidth = 3;
    this.ctx.beginPath();
    this.ctx.moveTo(0, this.groundY);
    this.ctx.lineTo(width, this.groundY);
    this.ctx.stroke();

    this.ctx.fillStyle = "#9a8c64";
    for (let i = 0; i < 26; i += 1) {
      const x = ((this.score * -14 + i * 84) % (width + 90)) - 20;
      this.ctx.fillRect(x, this.groundY + 19 + (i % 3) * 9, 28, 3);
    }
  }

  private drawDino(): void {
    const height = this.isDucking ? 42 : 72;
    const width = this.isDucking ? 72 : 48;
    const x = dinoX;
    const y = this.groundY - height + this.dinoY;

    this.ctx.fillStyle = "#27374d";
    this.ctx.fillRect(x, y + 8, width, height - 8);
    this.ctx.fillRect(x + width - 15, y, 24, 24);
    this.ctx.fillStyle = "#fdfbf4";
    this.ctx.fillRect(x + width + 1, y + 7, 5, 5);
    this.ctx.fillStyle = "#27374d";
    this.ctx.fillRect(x + 7, y + height, 11, 22);
    this.ctx.fillRect(x + width - 21, y + height, 11, 22);
  }

  private drawObstacle(obstacle: Obstacle): void {
    this.ctx.fillStyle = obstacle.kind === "bird" ? "#8f3f2f" : "#2f6f4e";
    if (obstacle.kind === "bird") {
      this.ctx.fillRect(obstacle.x, obstacle.y + 18, obstacle.width, 20);
      this.ctx.fillRect(obstacle.x + 15, obstacle.y, 16, obstacle.height);
      return;
    }

    this.ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
    this.ctx.fillRect(obstacle.x - 12, obstacle.y + 22, 12, 10);
    this.ctx.fillRect(obstacle.x + obstacle.width, obstacle.y + 34, 14, 10);
  }

  private drawOverlay(width: number, height: number): void {
    this.ctx.fillStyle = "rgba(253, 251, 244, 0.72)";
    this.ctx.fillRect(0, 0, width, height);
    this.ctx.fillStyle = "#222831";
    this.ctx.font = "700 24px ui-sans-serif, system-ui";
    this.ctx.textAlign = "center";
    this.ctx.fillText(this.gameOver ? "Game over" : "Paused", width / 2, height / 2 - 16);
    this.ctx.font = "500 15px ui-sans-serif, system-ui";
    this.ctx.fillText("Press Space to run again", width / 2, height / 2 + 16);
  }

  private emit(): void {
    this.onChange(this.getSnapshot());
  }
}
