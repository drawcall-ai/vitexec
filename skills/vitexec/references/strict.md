# Strict mode

`vitexec --strict script.ts` runs the script in the vitexec process, next to Playwright, instead of inside the page. The script can only observe the app and send real input, so it cannot cheat by writing state, calling app methods, or dispatching synthetic events. The app runs exactly as a user would see it, on its normal route.

```ts
import { observe, load, mouse, keyboard, sleep } from "vitexec/strict";

const state = await load("/src/store.ts");
while (!(await observe((m) => m.ready.value, state))) await sleep(50);

await mouse.moveTo(640, 360);
await mouse.click();
await keyboard.press("Enter");
console.log("score", await observe(() => window.game.score));
```

That import is the only one allowed; it supplies types and is stripped at run time. Everything else the script needs must come through `observe`.

## observe: read-only by construction

`observe(fn, ...args)` serializes `fn`, runs it in the page under V8's side-effect check, and returns its JSON value. Consequences that shape how to write it:

- `fn` cannot close over script variables. Pass them as `args`; module handles from `load()` are passed the same way and arrive as the module namespace.
- Any store to existing state, timer, promise, `async`, or DOM mutation makes the call reject with `observe() must be read-only`. V8's check is conservative: it also rejects app functions that construct class instances (a three.js `new Vector3()` inside a helper), read imported bindings (a closure over a module import), cache lazily, or `Object.assign`/spread app objects. So an app's convenience methods often fail even when they only read. Expect that, and read the underlying fields instead: `system.bots.filter(b => b.deadAt <= 0).map(b => [b.char.position.x, b.char.position.z])` works where `system.livePositions()` does not. Pure methods that only touch `this` (counters, `getBoundingClientRect()`, `Array` methods) are fine.
- When a call is rejected, the error prints the function; split it into smaller `observe` calls to find the offending read rather than guessing.
- The return value must be JSON: project to numbers, strings, booleans, arrays, and plain objects. Returning a large object graph is slow; return what the next decision needs.
- A call that runs longer than 2 s is terminated and rejects; the page keeps running.
- One call is one CDP round trip, about a millisecond on the same machine, so an observe → act → observe loop can run at roughly 100 Hz.

Start discovery with a broad read such as `Object.keys(window.app)` or a `load()` of the module the app's entry imports, then narrow.

## mouse and keyboard: real, paced input

Input goes through Playwright as trusted Chromium events, so the app's own listeners, focus rules, and pointer lock apply exactly as for a person.

- `mouse.move(dx, dy)` and `mouse.moveTo(x, y)` glide along the path at a capped speed (3000 CSS px/s, 125 events/s) and resolve when the pointer arrives. A long move takes time; a loop that re-observes between short moves tracks a moving target better than one long move computed from stale state.
- Under pointer lock the app sees `movementX/Y` per event and the position is unbounded, so relative `move` is the natural call; `mouse.position` reports where the pointer is.
- `mouse.down/up/click(button)` and `keyboard.down/up/press(key)` act at the current pointer position. `key` is a Playwright key name (`KeyW`, `Space`, `ShiftLeft`, `Enter`). Holds persist across other calls until the matching `up`; anything still held is released when the script ends.
- Moves are queued in order; keys and buttons are independent of the move queue, so a movement key can stay held while the pointer aims.

Do not assume an app's input mapping. Measure it: make one small move, observe the resulting change, and derive the ratio and sign before relying on it.

## Shape and limits

- Ordinary top-level-await script, `.ts` or `.js`; TypeScript types are stripped.
- No page globals, no DOM, no imports other than `vitexec/strict`.
- `console.log` prints as `[log]` lines alongside the page's own console output; a thrown error prints as `[error]` and ends the run with held input released.
- `--path`, `--timeout`, `--screenshot`, `--record`, and the other run options work unchanged.
