# Human-like input

Use the `mouse` and `keyboard` facade when an effect should reach the app through Chromium's real input path. The script still runs in the page and can read DOM or imported application state, while Vitexec routes each facade call through Playwright. The resulting events are trusted and obey normal focus and pointer-lock behavior.

```ts
import { keyboard, mouse } from "vitexec";

const target = document.querySelector("button.save");
if (!(target instanceof HTMLElement)) throw new Error("Save button not found");

const box = target.getBoundingClientRect();
await mouse.moveTo(box.x + box.width / 2, box.y + box.height / 2);
await mouse.click();
await keyboard.press("Enter");
```

Read state to choose an action, send physical input, then read state again to verify the application outcome. Do not call an application mutation method or dispatch a synthetic event as proof of user interaction.

## Pointer movement

- `mouse.move(dx, dy, { durationMs })` follows a relative path.
- `mouse.moveTo(x, y, { durationMs })` follows an absolute viewport path.
- Both settled calls accelerate and decelerate at 60 events per second with a 1200 CSS px/s ceiling. A requested duration is lengthened when necessary to respect that ceiling.
- The nominal settled duration in milliseconds is `max(80, requestedDuration ?? 0, 1.5 * distance * 1000 / 1200)`. Browser scheduling may add a little wall time.
- The page keeps running while an awaited settled move follows its path. Use settled movement for a stable destination.
- `mouse.moveLatest(dx, dy)` and `mouse.moveToLatest(x, y)` return after their first event while the remaining path continues for up to 400 ms. A later latest call replaces the unfinished destination. Use this for an observe → aim → observe loop whose target or application state can move.
- A finite, non-zero relative delta smaller than one CSS pixel becomes one physical pixel instead of disappearing in Chromium's integer `movementX/Y` quantization.
- `mouse.stop()` ends replaceable movement before switching to a settled move.

Under pointer lock, prefer relative movement. Chromium reports the path through `movementX/Y` even when the logical coordinates leave the viewport. Pointer sensitivity and sign belong to the application: measure its heading before and after a small known delta instead of assuming either. Acquiring pointer lock requires focus and a trusted activation such as `mouse.click()`; verify `document.pointerLockElement`. That activation still reaches the application, so acquire lock before arming a primary-click action or at another safe moment. A compatible Playwright Chromium can grant pointer lock in headless mode, as well as in an adopted or remote headed page.

## Buttons and keys

- `mouse.click(button, { durationMs })` and `keyboard.press(key, { durationMs })` hold for 80 ms by default so frame-sampled controls see the edge.
- `mouse.down(button, { releaseAfterMs })` and `keyboard.down(key, { releaseAfterMs })` start a hold. Repeating `down` renews its deadline without emitting another edge.
- Pair an open-ended hold with `up`. Vitexec releases any controls still held when the script finishes.
- Input durations must be finite and greater than zero. Key and button holds may be as long as the interaction needs. Mouse movement is capped at 1500 ms; split a longer path into fresh observed decisions.

Mouse buttons are `"left"`, `"middle"`, and `"right"`. Keyboard values use Playwright names such as `"KeyW"`, `"Space"`, `"ShiftLeft"`, and `"Enter"`.

Keys and buttons remain independent from pointer motion. A movement key can stay held while `moveLatest` updates aim from fresh application state.

For example, keep a normal button hold active while replacing aim with each fresh observation:

```ts
await mouse.down("left", { releaseAfterMs: 500 });
for (let step = 0; step < 12 && targetIsActive(); step += 1) {
  const { dx, dy } = readAimCorrection();
  await mouse.moveLatest(dx, dy);
  await new Promise((resolve) => setTimeout(resolve, 32));
}
await mouse.stop();
await mouse.up("left");
```
