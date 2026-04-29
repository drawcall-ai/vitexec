---
name: vitexec
description: Use this skill when an AI agent needs to inspect, verify, or debug a live Vite app by running a temporary snippet inside the browser page and reading the returned browser logs. Especially useful for checking client state after interactions, imported app modules, canvas/WebGL/Three.js state, screenshots, and runtime-only behavior without editing app files.
---

# vitexec

Use `vitexec` when the truth you need lives inside a running Vite page: client stores, app modules, DOM state, canvas/WebGL state, or browser-only errors.

Do not use it for static checks that can be answered from files, unit tests, or TypeScript alone.

## Install If Missing

First check whether the project already has `vitexec`:

```sh
pnpm why vitexec
```

If missing, install it with Playwright:

```sh
pnpm add -D vitexec playwright
pnpm exec playwright install chromium
```

## Workflow

1. Identify the page path if it is not `/`.
2. Write a small snippet that imports app modules or reads browser state.
3. Run `vitexec '<snippet>'`, or add `--path <path>` for a route.
4. Add `--config <path>` only when Vite config is not in the default location.
5. Treat stdout as browser logs. It starts with `logs:`.

Example:

```sh
vitexec 'console.log("ready")'
```

Expected shape:

```txt
logs:
[log] ready
```

## Common Patterns

Read client state after interaction:

```sh
vitexec --path /cart '
  import { useCartStore } from "/src/store/cart.ts";

  document.querySelector("[data-testid=add-to-cart]")?.click();
  await new Promise((resolve) => requestAnimationFrame(resolve));

  console.log("cart", JSON.stringify(useCartStore.getState().items));
'
```

Inspect imported app objects:

```sh
vitexec '
  import { camera, cube, Vector3 } from "/src/scene-state.ts";
  const p = cube.getWorldPosition(new Vector3()).applyMatrix4(camera.matrixWorldInverse);
  console.log("front-left", p.z < 0 && p.x < 0);
'
```

Capture a screenshot:

```sh
vitexec --screenshot ./artifacts/page.png 'console.log("captured")'
```

Record a video:

```sh
vitexec --record ./artifacts/page.webm 'console.log("recorded")'
```

Use GPU mode for canvas/WebGL/Three.js checks:

```sh
vitexec --gpu 'console.log(Boolean(document.createElement("canvas").getContext("webgl")))'
```

Use a custom Vite config location:

```sh
vitexec --config ./apps/web/vite.config.ts --path /dashboard 'console.log("ready")'
```

## Interpreting Output

Useful lines:

```txt
[log] ...
[warning] ...
[page error] ...
[http 404] GET ... Not Found
[screenshot] ./path.png
[recording] ./path.webm
```

If output is empty, the snippet may not have logged anything, the page may not have loaded, or the wrong path was used.

If imports fail, prefer browser-root app paths such as `/src/store.ts`, not local filesystem paths.

## Guidance For Agents

- Keep snippets short and focused on one question.
- Prefer importing app modules over scraping DOM when state is exported.
- Log JSON for structured data: `console.log("state", JSON.stringify(value))`.
- Use `--path <path>` when the state lives on a route other than `/`.
- Use `--config <path>` when the project has a non-standard Vite config location.
- Use `--gpu` for WebGL/canvas/Three.js behavior.
- Use `--screenshot <path>` when visual state matters.
- Use `--record <path>` when an interaction sequence matters.
- Do not leave temporary code in the app when `vitexec` can inspect it from outside.
