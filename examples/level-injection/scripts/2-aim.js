import { mouse } from "vitexec";
import { getState } from "/src/main.ts";

if (getState().level !== 2) throw new Error("Expected the aiming level.");
for (const number of [1, 2, 3]) {
  const target = document.querySelector(`[data-target="${number}"]`);
  if (!target) throw new Error(`Missing target ${number}.`);
  const { x, y, width, height } = target.getBoundingClientRect();
  await mouse.moveTo(x + width / 2, y + height / 2);
  await mouse.click();
}
if (getState().level !== 3) throw new Error("Did not hit all targets.");
console.log("Aim complete", getState());
