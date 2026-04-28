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

Ensure the Vite app uses the plugin:

```ts
import { defineConfig } from "vite";
import { vitexec } from "vitexec";

export default defineConfig({
  plugins: [vitexec()]
});
```

## Workflow

1. Start or reuse the Vite dev server.
2. Identify a page URL, usually `http://localhost:5173/`.
3. Write a small snippet that imports app modules or reads browser state.
4. Run `vitexec <url> '<snippet>'`.
5. Treat stdout as browser logs. It starts with `logs:`.

Example:

```sh
vitexec http://localhost:5173/ 'console.log("ready")'
```

Expected shape:

```txt
logs:
[log] ready
```

## Common Patterns

Read client state after interaction:

```sh
vitexec http://localhost:5173/cart '
  import { useCartStore } from "/src/store/cart.ts";

  document.querySelector("[data-testid=add-to-cart]")?.click();
  await new Promise((resolve) => requestAnimationFrame(resolve));

  console.log("cart", JSON.stringify(useCartStore.getState().items));
'
```

Inspect imported app objects:

```sh
vitexec http://localhost:5173/ '
  import { camera, cube, Vector3 } from "/src/scene-state.ts";
  const p = cube.getWorldPosition(new Vector3()).applyMatrix4(camera.matrixWorldInverse);
  console.log("front-left", p.z < 0 && p.x < 0);
'
```

Capture a screenshot:

```sh
vitexec --screenshot ./artifacts/page.png http://localhost:5173/ 'console.log("captured")'
```

Use GPU mode for canvas/WebGL/Three.js checks:

```sh
vitexec --gpu http://localhost:5173/ 'console.log(Boolean(document.createElement("canvas").getContext("webgl")))'
```

## Interpreting Output

Useful lines:

```txt
[log] ...
[warning] ...
[page error] ...
[http 404] GET ... Not Found
[screenshot] ./path.png
```

If output is empty, the snippet may not have logged anything, the page may not have loaded, or the wrong URL was used.

If imports fail, prefer browser-root app paths such as `/src/store.ts`, not local filesystem paths.

## Guidance For Agents

- Keep snippets short and focused on one question.
- Prefer importing app modules over scraping DOM when state is exported.
- Log JSON for structured data: `console.log("state", JSON.stringify(value))`.
- Use `--gpu` for WebGL/canvas/Three.js behavior.
- Use `--screenshot <path>` when visual state matters.
- Do not leave temporary code in the app when `vitexec` can inspect it from outside.
