# Input in strict mode

Use strict input when an effect must reach the application through the same browser keyboard or pointer path as a person. Strict source still runs in the live page, but Vit Exec verifies it before execution.

The effect boundary is simple: only direct `input(...)` calls may act. `observe(...)` and other permitted reads are observations only. Do not assign into application state, call its mutation methods, dispatch synthetic DOM events, or bypass its normal interaction path.

## Start from the public contract

Check the installed CLI and types rather than guessing:

```sh
npx vitexec --help
npx vitexec --strict-check vitexec/check.ts
npx vitexec --strict vitexec/check.ts
```

Work from this public contract. Do not inspect verifier, browser-transport, or host implementation internals to author strict source.

Strict source uses exact direct imports:

```ts
import { input, observe } from "vitexec";
```

When the app installed a trusted read-only provider, `observe()` returns its serialized JSON snapshot. Log it to find current paths and values, then request only the fields needed for the next decision and its verification:

```ts
import { input, observe } from "vitexec";

console.log(observe());

const state = observe({
  ready: { kind: "boolean", path: ["session", "ready"] }
});

if (state.ready) {
  await input({ type: "keyboard.press", key: "Enter", durationMs: 80 });
}
```

The example path is illustrative, not universal. The application owns its schema. Missing providers and invalid projections fail visibly. If no provider exists, use visible text, screenshots, or a documented read-only application API in ordinary mode.

The serialized discovery value is for passive logging; strict source cannot parse or traverse it. Current values do not establish semantics or actionability. A literal `observe({...})` projection declares its path, primitive kind, nullability, and optionality. `nullable: true` permits `null`, never a container. `optional: true` requires `nullable: true` and returns `null` for an absent own-property path; a wrong container still fails visibly. `--strict-check` validates source shape, while paths and current values are validated when `observe({...})` runs.

Before input, project and test any app-owned condition whose change would make the next effect invalid. When selecting from a changing collection, project a stable identity with the selected item and re-check it before a dependent effect; a list position is not identity. Do not infer actionability from coordinates or identifiers alone.

Treat a changing precondition as a state transition: use a bounded observe/wait loop until it becomes ready or terminal. A fixed delay or one snapshot does not prove later readiness.

Judge an interaction by its app-owned postcondition, not by whether the input command was accepted. If one activation exposes another step instead of completing the goal, observe the new actionable state and continue through ordinary input until the intended postcondition is true or a bounded failure is reached.

Before triggering a timed or otherwise irreversible application phase, prepare and run `--strict-check` on the complete source needed to start, observe, act, and detect completion. Execute that source once only after it passes. Authoring and verifier iteration should not consume the application's active deadline. If a measurement requires entering the phase, put that measurement at the start of the same pre-checked source and use its result immediately; do not enter the phase in a separate authoring probe.

## Choose input by physical intent

Choose the least stateful command that preserves the interaction's physical semantics. Use `click` or `press` for one activation and `move` or `moveTo` for one settled pointer destination. Use `down`/`up` or `moveLatest` only when the interaction must remain active across later observations.

| Intent | Command shape |
| --- | --- |
| Activate one unique visible element | `{ type: "mouse.click", target: "button.save" }` |
| Activate a known viewport point | `{ type: "mouse.click", x, y }` |
| Emit one key press | `{ type: "keyboard.press", key: "Enter", durationMs: 80 }` |
| Emit one pointer-button press | `{ type: "mouse.press", button: "left", durationMs: 80 }` |
| Hold until a later decision | matching `down` then `up` |
| Hold for a bounded interval without blocking the loop | `down` with `releaseAfterMs` |
| Follow one fixed relative pointer path | `{ type: "mouse.move", deltaX, deltaY, durationMs }` |
| Follow one fixed absolute pointer path | `{ type: "mouse.moveTo", x, y, durationMs }` |
| Continuously replace a relative destination | `{ type: "mouse.moveLatest", deltaX, deltaY }` |
| Continuously replace an absolute destination | `{ type: "mouse.moveLatest", x, y }` |
| End active replaceable pointer movement | `{ type: "mouse.stop" }` |
| Yield in the browser without claiming an observed transition | `{ type: "wait", durationMs }` |

Selector clicks must resolve to exactly one visible element. Before a timed or irreversible phase, prove the selector is unique from the app's visible structure or source; do not guess broad selectors such as `button`, `canvas`, or `[role="button"]`. Coordinate clicks and other absolute coordinates use CSS pixels in the viewport. Relative movement starts at the current physical pointer position and, under pointer lock, produces relative deltas.

`mouse.move` and `mouse.moveTo` are settled trajectories: awaiting one blocks until its endpoint is reached or a newer trajectory supersedes it. Use one when reaching that endpoint is a precondition for the next decision. Their receipt reports the applied delta, duration, steps, and whether they were superseded. One request describes the complete trajectory; do not serialize a browser round trip per point.

`mouse.moveLatest` is an adaptive-movement option, not the default pointer move. It returns after its first real pointer event, while movement continues independently. A later call discards the unapplied remainder of the previous one. Use it only when the destination may change before a settled move completes and unapplied intermediate motion has no application meaning. Awaiting a settled move on every iteration serializes observation and movement; `moveLatest` lets the source observe fresh feedback while movement continues. Its receipt proves one pointer event was delivered, not that a frame rendered, the destination was reached, or application state changed. The receipt's `leaseMs` starts at that first event. Replacing the destination renews the lease; otherwise movement stops when it expires without a separate notification. While it is active, `click`, `move`, and `moveTo` fail with `InputBusyError`; call `mouse.stop` before switching to one of them.

For changing feedback, use one short control loop: observe, replace the movement, then observe again. An accepted pointer command proves input delivery, not that the observed condition used to choose it is still current. Before a separate effect that depends on that condition, re-observe; if it changed, replace or stop the movement.

Relative `mouse.moveLatest` deltas use physical CSS-pixel steps. A nonzero component smaller than one CSS pixel is clamped to one pixel in the same direction so a valid correction cannot disappear at the browser's event boundary.

Independent physical channels should remain independent. When fresh application feedback authorizes a bounded hold while the pointer must keep adapting, start that hold once and update `mouse.moveLatest` from fresh feedback in the same source. Alternating a settled pointer move with one activation serializes two independent actions and leaves feedback stale during each one. Keep them sequential only when reaching the pointer endpoint is genuinely a precondition for activation.

Call feedback fresh only when an app-owned revision, simulation time, frame marker, lifecycle state, or observed value changed. The time an observation was captured is not app-owned feedback. Re-reading the same snapshot after an accepted command is not fresh feedback. `wait` is a browser-local timer yield; it does not cross the Playwright host or prove that the application rendered a new frame.

When feedback and physical input may use different units, directions, or coordinate systems, do not infer their relationship from names or conventions. If a probe is safe and can be undone, measure the local response with a small input, undo it, and verify restoration. A clamped, saturated, or unchanged response does not establish direction or gain; probe the opposite direction and require inverse restoration. Otherwise fail visibly rather than guess.

When the app-owned marker is unchanged, wait, then observe again. Stop on an app-owned completion condition and give the loop an independent local iteration bound. Repeated CLI/module submissions add authoring and transport gaps between decisions.

`mouse.stop` stops only active `mouse.moveLatest` motion. It does not release mouse buttons.

## Activations, holds, and cleanup

Use `press` when one complete activation must finish before the next decision. If another activation depends on changed application state, observe again first. Use `down` and `up` for a hold spanning several decisions. Adding `releaseAfterMs` makes that hold release autonomously without blocking the loop. Reissuing `down` changes only its release deadline and emits no new edge; omitting `releaseAfterMs` removes the deadline. Down receipts expose the hold's lease information.

Give every hold a bounded lease, renew it only while a fresh observation still authorizes it, and explicitly release it on every normal exit. The default CLI host accepts at most 1500 ms per press or hold and rejects longer requests. Replace `mouse.moveLatest` only from fresh feedback; when movement is no longer authorized, call `mouse.stop`.

Always release held keys and buttons on every normal exit path. Trusted runtime policy owns pointer-movement pacing, interpolation, speed limits, duration clamping, and individual physical edge delivery. Source authorizes each activation edge. The complete public union is `InputPhysicalCommand` from `vitexec`.

## Strict-source shape

The initial strict language is deliberately small and syntactic:

- exact direct imports of `input` and `observe` from `vitexec`;
- direct `observe()` calls or literal primitive projections;
- direct awaited `input(...)` calls;
- passive `console.log(...)` calls; multiple values must each be syntax-proven primitives;
- local primitive computation, `if`, and `while` control flow;
- passive reads allowed by the verifier.

Helpers, callbacks, array iteration methods, iterators, object construction, dynamic imports, external calls, and writes are outside the subset. This is a fail-closed source policy, not a claim of whole-language semantic purity. If verification rejects a convenient form, simplify the submitted source rather than bypassing the verifier.
