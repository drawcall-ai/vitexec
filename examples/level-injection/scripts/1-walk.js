import { keyboard } from "vitexec";
import { getState } from "/src/main.ts";

if (getState().level !== 1) throw new Error("Expected the walking level.");
for (const key of ["ArrowUp", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowRight", "ArrowDown"]) {
  await keyboard.press(key);
}
if (getState().level !== 2) throw new Error("Did not reach the exit.");
console.log("Walk complete", getState());
