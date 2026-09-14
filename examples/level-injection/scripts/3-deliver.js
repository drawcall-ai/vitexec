import { mouse } from "vitexec";
import { getState } from "/src/main.ts";

if (getState().level !== 3) throw new Error("Expected the delivery level.");
function center(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing ${id}.`);
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x: x + width / 2, y: y + height / 2 };
}
const parcel = center("parcel");
const dock = center("dock");
await mouse.moveTo(parcel.x, parcel.y);
await mouse.down();
await mouse.moveTo(dock.x, dock.y);
await mouse.up();
if (getState().level !== 4) throw new Error("Did not deliver the parcel.");
console.log("Game complete", getState());
