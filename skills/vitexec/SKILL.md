---
name: vitexec
description: Inspect, verify, interact with, or profile a live Vite app by running temporary scripts in its browser page. Use for runtime state, physical input, browser logs, screenshots, recordings, and performance artifacts; prefer static inspection for questions the source can answer.
---

# vitexec

Use `vitexec` when the truth lives in the running browser: client state, imported app modules, DOM, canvas/WebGL, screenshots, recordings, or browser-only errors.

Prefer static files, unit tests, or TypeScript for questions they can answer directly.

## References

- For mouse, keyboard, or pointer lock, read [references/inputs.md](references/inputs.md).
- For CPU, network, performance timeline, or heap analysis, read [references/performance.md](references/performance.md).
- For WebXR, read [references/webxr.md](references/webxr.md).

## Workflow

1. Identify the page path if it is not `/`.
2. Write the smallest snippet that performs the user-like action or reads the browser-only state.
3. Run `vitexec '<snippet>'` or `vitexec check.ts` for `./vitexec/check.ts`.
4. Inspect the logs and exit status. A script failure or timeout exits nonzero; printed errors are not successful completion.

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

Browser windows are hidden by default. When the user wants to watch, add `--headed`
to the one-shot command or `open`, not `run`. Programmatically, pass
`headless: false` to `openPage` or `openBrowser`. For remote launches, the window appears on the remote host; connecting to an
already-running browser does not change its visibility.

## Reusing a page

Use a session when later scripts need the state created by earlier actions:

```sh
vitexec open game
vitexec run game setup.ts
vitexec run game play.ts
```

Start `open` with the agent's background-terminal tool; it remains in the foreground
and streams ordinary page diagnostics. `run` waits for page startup automatically.
Use the same working directory for all commands. Browser/Vite/viewport options go
on `open`; per-run screenshots, recordings, and profiles go on `run`.

Each `run` waits for execution and streams console logs traceable to its script.
App logs without an identifiable script stack stay in `open`, including some logs
triggered by physical input. Check that output when investigating app failures.
Scripts should await the work whose logs they need. After an execution timeout, stop and restart
the session: the old code may still be running.

Separate `run` calls may overlap for observation alongside input. They share the same
page; use one input driver at a time. Recording/profiling operations cannot overlap.
When done, stop the `open` process with SIGINT or SIGTERM and await its exit;
it closes the page, browser, and server.

For programmatic composition, use `const page = await openPage(options)`,
`await run(page, code, { onLog })`, and `await page.close()` in `finally`.
`openPage` owns its server and browser; its `onLog` receives page diagnostics.
`run` only injects into an existing Chromium page and never navigates or closes it.

## Guidance

- Prefer importing exported app state over scraping DOM when state is available.
- Prefer direct state reads for assertions; use physical input when verifying user interactions.
- Use `mouse` and `keyboard` from `vitexec` for physical input; synthetic DOM events do not verify the same behavior.
- `--timeout` budgets navigation on `open` and connection, startup, and execution on `run`; budget physical-input wall time, not only application time.
- Use live progress logs and focused assertions to early-exit on failures and see current progress.
- Keep logs concise; overly verbose logs become unreadable and unnecessarily fill the context.
- Prefer browser-root imports such as `/src/store.ts`, not local filesystem paths.
- Use `--gpu` for WebGL, canvas, Three.js, and WebXR behavior.
- If the local machine has no usable GPU, use `--gpu --browser-ws-endpoint <ws-url>` to connect to a remote Playwright server that was started with the right host-specific GPU settings.
- If repeated runs need the same endpoint or artifact settings, prefer `VITEXEC_*` environment variables over repeating long flags.
- Use screenshots or recordings only when visual evidence matters.
- Prefer temporary Vitexec scripts over adding inspection code to the app.

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

Inspect screenshots or recordings against the requested outcome: a rendered frame
alone does not prove correct behavior. Check visual defects relevant to the app,
and pair visual evidence with state assertions when possible (for example, the
count changed, an entity disappeared, or the animation advanced).
