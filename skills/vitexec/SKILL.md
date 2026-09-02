---
name: vitexec
description: Inspect, verify, interact with, or profile a live Vite app by running temporary source in its browser page. Use for runtime state, browser logs, real keyboard or pointer input, screenshots, recordings, and performance artifacts. Do not use as a substitute for static source review or unit tests.
---

# Vit Exec

Vit Exec runs temporary source in the live Vite page's JavaScript context. It does not create a sandbox, worker, iframe, or snapshot boundary.

Use ordinary mode for trusted diagnostic code. Use `--strict` when effects must be limited to the fail-closed strict subset: read-only observation plus approved physical input.

## Strict physical input: choose the least stateful command

- Use `click` or `press` for one completed activation. If another activation depends on changed application state, observe again first.
- Use matching `down` and `up` only for an effect intended to remain continuous across later observations. `releaseAfterMs` is a fail-safe auto-release. Reissuing `down` changes only its release deadline and emits no new edge; omitting `releaseAfterMs` removes the deadline.
- Use settled `mouse.move` or `mouse.moveTo` for one destination.
- Use `mouse.moveLatest` only when later observations may replace unapplied movement.

An input receipt proves physical delivery, not an application transition. Observe the app-owned postcondition after input. Bound loops and leases, and stop movement or release held controls on normal exit.

The runtime owns pointer-movement pacing, interpolation, speed and duration limits, individual physical edge delivery, and leases. Source authorizes each activation edge. Read [references/inputs.md](references/inputs.md) for the complete command shapes, observation rules, selector constraints, and cleanup requirements.

## Workflow

1. Identify the app root and page path.
2. Prefer an exported runtime API or installed observation provider over inferred globals.
3. Write the smallest source that answers one question or reaches one app-owned postcondition. When reaching it depends on changing feedback, keep the complete observe → input → re-observe loop in that source.
4. Check strict source with `npx vitexec --strict-check`; execute it with `npx vitexec --strict`.
5. Read the emitted logs or requested artifact and decide from observed state.

Prefer a source file when imports, input, or more than one expression are involved:

```sh
npx vitexec --path /settings vitexec/check.ts
npx vitexec --strict-check vitexec/interact.ts
npx vitexec --strict --path /settings vitexec/interact.ts
```

Small trusted checks may be inline in ordinary mode:

```sh
npx vitexec 'console.log(document.title)'
```

Vit Exec resolves an existing `.ts`, `.tsx`, `.js`, `.jsx`, `.mts`, or `.mjs` argument as a file. Browser `console.log` output is forwarded to stdout. Run `npx vitexec --help` for the current option set, including `--gpu`, `--record`, `--screenshot`, `--timeout`, and `--viewport`.

## Guidance

- Treat application reads as observations and assertions, never as a route to mutation.
- Default to the app's normal user-facing route. Do not switch to proof, demo, capture, fixture, or example pages unless the user asked for one; those pages may have different lifecycle and timing behavior.
- In strict mode, start runtime discovery with `console.log(observe())`; it returns the provider snapshot or fails visibly. Then project only the primitive fields needed for the next decision and its verification.
- Browser-root imports such as `/src/store.ts` are available in ordinary mode when no provider exists.
- Use real input for effects. Do not dispatch synthetic DOM events or invoke application mutation methods as substitutes.
- Request GPU mode only when accelerated rendering is material to the result.
- Capture screenshots or recordings only when visual evidence matters; state what they demonstrate.
- Keep temporary source outside the application source tree when practical.

For performance capture, read [references/performance.md](references/performance.md). WebXR emulation is an ordinary-mode workflow; read [references/webxr.md](references/webxr.md).

## Project integration

Install the Vite plugin when the project needs a trusted observation provider or browser input transport:

```ts
import { defineConfig } from "vite";
import { vitexec } from "vitexec";

export default defineConfig({ plugins: [vitexec()] });
```
