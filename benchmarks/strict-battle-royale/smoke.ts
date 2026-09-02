import { observe, mouse, keyboard, sleep } from "vitexec/strict";

const t0 = performance.now();
const since = () => Math.round(performance.now() - t0);

while (!(await observe(() => Boolean((window as any).LASTDROP)))) await sleep(100);
console.log("booted", since(), "ms");

const clickCenter = async (selector: string) => {
  const box = await observe((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width };
  }, selector);
  if (!box || !box.w) throw new Error(`no visible ${selector}`);
  await mouse.moveTo(box.x, box.y);
  await mouse.click();
};

await sleep(800);
await clickCenter("#flow-title .drop");
await sleep(800);
await clickCenter("#flow-brief .launch");
console.log("launched", since(), "ms");

const phase = () => observe(() => (window as any).LASTDROP.state.phase as string);
let waited = 0;
while ((await phase()) !== "match") {
  await sleep(500);
  waited += 500;
  if (waited % 2000 === 0) console.log("waiting", waited, JSON.stringify(await observe(() => {
    const L = (window as any).LASTDROP;
    const p = L.refs.commando.position;
    return { phase: L.state.phase, frame: L.renderer.info.render.frame, y: Math.round(p.y * 10) / 10, drop: document.querySelector("#flow-drop")?.className, brief: document.querySelector("#flow-brief")?.className, title: document.querySelector("#flow-title")?.className };
  })));
  if (waited > 20000) throw new Error("drop never completed");
}
console.log("match", since(), "ms");

const snap = () => observe(() => {
  const L = (window as any).LASTDROP;
  const p = L.refs.commando.position;
  return {
    pos: [p.x, p.y, p.z].map((v: number) => Math.round(v * 100) / 100),
    yaw: L.cameraBehavior.rotationYaw,
    pitch: L.cameraBehavior.rotationPitch,
    locked: document.pointerLockElement === L.renderer.domElement,
    bots: L.world.systems.find((s: any) => s.constructor.name === "AndroidSystem").bots.filter((b: any) => b.deadAt <= 0).map((b: any) => [b.char.position.x, b.char.position.z].map((n: number) => Math.round(n * 10) / 10)),
    armed: L.world.systems.find((s: any) => s.constructor.name === "InventorySystem").isArmed(),
  };
});
console.log("start", JSON.stringify(await snap()));

await mouse.moveTo(640, 360);
await mouse.click();
await sleep(200);
const before = await snap();
await mouse.move(100, 0);
await sleep(100);
const after = await snap();
console.log("lock", before.locked, after.locked, "yaw", before.yaw, "->", after.yaw, "ratio", (after.yaw - before.yaw) / 100);

await keyboard.down("KeyW");
await sleep(1000);
await keyboard.up("KeyW");
const moved = await snap();
console.log("moved", JSON.stringify(moved.pos), "from", JSON.stringify(before.pos));
try {
  await observe(() => { (window as any).LASTDROP.state.won = true; });
  console.log("CHEAT ALLOWED");
} catch (e) {
  console.log("cheat blocked:", (e as Error).message.split(";")[0]);
}
console.log("done", since(), "ms");
