import { WebGLRenderer } from "three";
import { camera, resizeCamera, scene } from "./scene-state";
import "./style.css";

const app = document.querySelector<HTMLDivElement>("#app");

if (!app) {
  throw new Error("Missing #app element.");
}

const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
app.append(renderer.domElement);

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height);
  resizeCamera(width, height);
}

window.addEventListener("resize", resize);
resize();

function render(): void {
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

render();

