---
name: vitexec
description: Use this skill when an AI agent needs to inspect, verify, debug, profile, or play through a live Vite app by running temporary scripts against the browser page and reading browser logs or captured artifacts. Use for client state after interactions, imported app modules, DOM state, human-like input, canvas/WebGL/Three.js state, screenshots, videos, CPU/network/performance/heap analysis, WebXR/Three.js XR with IWER, and runtime-only behavior without editing app files.
---

# vitexec

Use `vitexec` when the truth lives in the running browser: client state, imported app modules, DOM, canvas/WebGL, screenshots, recordings, or browser-only errors.

Do not use it for questions static files, unit tests, or TypeScript can answer directly.

## References

- For mouse, keyboard, or pointer lock, read [references/inputs.md](references/inputs.md).
- For CPU, network, performance timeline, or heap analysis, read [references/performance.md](references/performance.md).
- For WebXR, read [references/webxr.md](references/webxr.md).

## Workflow

1. Identify the page path if it is not `/`.
2. Write the smallest snippet that performs the user-like action or reads the browser-only state.
3. Run `vitexec '<snippet>'` or `vitexec check.ts` for `./vitexec/check.ts`, adding `--path`, `--gpu`, `--screenshot`, `--record`, `--cpu-profile`, `--network-trace`, `--performance-trace`, `--heap-snapshot`, `--timeout`, or `--config` only when needed.
4. Treat stdout as browser logs. It starts with `logs:`.

If `vitexec` itself is missing, install `vitexec` with the package manager already used by the project.

```sh
vitexec 'console.log("ready")'
vitexec check-scene.ts
```

For one argument, the CLI checks the path as written, then checks it below
`./vitexec`, then treats it as inline code.

For structured state, log JSON:

```sh
vitexec --path /cart '
  import { mouse } from "vitexec";
  import { useCartStore } from "/src/store/cart.ts";

  const button = document.querySelector("[data-testid=add-to-cart]");
  if (!(button instanceof HTMLElement)) throw new Error("Add button not found");
  const box = button.getBoundingClientRect();
  await mouse.moveTo(box.x + box.width / 2, box.y + box.height / 2);
  await mouse.click();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  console.log("cart", JSON.stringify(useCartStore.getState()));
'
```

## Guidance

- Prefer importing exported app state over scraping DOM when state is available.
- Use direct state reads for observation and assertions, not to bypass user interaction.
- Use `mouse` and `keyboard` from `vitexec` for physical input; do not substitute synthetic DOM events.
- `--timeout` covers boot, physical input, and script time; budget wall time, not only application time.
- Use live progress logs and focused assertions to early-exit on failures and see current progress.
- Keep logs concise; overly verbose logs become unreadable and unnecessarily fill the context.
- Prefer browser-root imports such as `/src/store.ts`, not local filesystem paths.
- Use `--gpu` for WebGL, canvas, Three.js, and WebXR behavior.
- If the local machine has no usable GPU, use `--gpu --browser-ws-endpoint <ws-url>` to connect to a remote Playwright server that was started with the right host-specific GPU settings.
- If repeated runs need the same endpoint or artifact settings, prefer `VITEXEC_*` environment variables over repeating long flags.
- Use screenshots or recordings only when visual evidence matters.
- Do not leave temporary code in the app when `vitexec` can inspect it from outside.

## Project integration

A Vite app can add `vitexec()` from the `vitexec` package. The plugin maps each
top-level module in `./vitexec` to a page with the same name:

```ts
import { vitexec } from "vitexec";

export default {
  plugins: [vitexec()]
};
```

```txt
vitexec/smoke.ts → /smoke.html
```

The mapping works in the Vite dev server and in `vite build`. Each generated page
loads the normal `index.html` and then its vitexec script. Multiple `vitexec()`
declarations are safe and deduplicated; conflicting page mappings fail clearly.

## Reading a screenshot as proof

A screenshot is only proof if you read it critically — "something rendered" is not "it works and looks right". When the evidence is a screenshot or clip, look at it for tells of unfinished work and treat any you find as a defect to fix, not as proof of done:

- A character standing in a **T-pose** (or not animating) — its rig/animation isn't driving the model.
- **Flat solid-color boxes/planes** standing in for real objects — placeholder geometry that needs a real asset or material.
- **Untextured surfaces** (a flat-color ground, gray "clay") — missing materials.
- Objects that **float** with no contact shadow — missing shadows or grounding.
- A **flat, raw render** with no finishing pass.

Pair the picture with state assertions: confirm the player-visible *outcome* from real app state (the count changed, the entity was removed, the animation state advanced), not just that the frame drew.
