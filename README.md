<div align="center">
  <img src="./assets/vitexec-header.svg" alt="vitexec header" />
</div>

Give AI agents a fast way to test your apps from the inside.

## Overview

`vitexec` is for checks that are too slow, visual, or stateful for normal agent
browser control.

Use it to let an agent play through a scene, steer a camera, test game-like
controls, inspect runtime state, and collect evidence without adding debug UI or
temporary app code.

## Install

Install the package in the Vite app:

```sh
pnpm add -D vitexec
```

Install the agent skill:

```sh
npx skills add drawcall-ai/vitexec
```

Then ask your agent to use it:

```txt
Use $vitexec to move through the scene and inspect the camera position.
```

## Problem

AI agents are slow when every action is a separate browser step.

Click, wait, inspect, press a key, wait again is expensive and often useless for
interactive apps where movement, camera, physics, timing, and input all happen
together.

The missing piece is a programmable control loop inside the running app.

## Solution

`vitexec` lets the agent run a script inside the page instead of controlling the
browser one action at a time.

The snippet can import real Vite modules, drive real input, wait for frames,
branch on state changes, and run full multi-step flows before logging the result.

Each run gets an isolated Vite server, its own Playwright browser, streamed logs,
and optional screenshots, videos, traces, profiles, HARs, or heap snapshots.

## Vite Plugin

Add the plugin to expose the scripts in `./vitexec` as app pages in both the dev
server and production build:

```ts
import { defineConfig } from "vite";
import { vitexec } from "vitexec";

export default defineConfig({
  plugins: [vitexec()]
});
```

```txt
index.html
vitexec/
  smoke.ts       → /smoke.html
  checkout.ts    → /checkout.html
```

Each generated page is the normal `index.html` plus its vitexec script. Only
top-level `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, and `.tsx` files become pages, so
scripts can import helpers from subdirectories.

Use an explicit mapping when the scripts live elsewhere:

```ts
vitexec({
  directory: false,
  pages: {
    "/checkout.html": "/checks/checkout.ts"
  }
});
```

Calling `vitexec()` more than once is safe. Identical directories and mappings
are deduplicated; conflicting mappings fail the Vite config instead of depending
on plugin order.

The generated pages are included by `vite build`. Do not deploy them with
production code if they perform destructive or privileged actions.

See the [plugin-only example](./examples/vite-plugin-pages) for the same routes
running under the normal Vite dev server and production build.

## Better Than Alternatives

- Instead of adding test functions to the app: keep checks outside production code
- Instead of judging screenshots only: log exact runtime state
- Instead of one slow browser action at a time: run a state-aware script in-page
- Instead of hand-writing Playwright-style setup: give the agent one CLI tool
- Instead of sharing one dev server: run isolated checks in parallel
- Instead of fighting HMR during checks: use a Vite server with HMR disabled

## Example

```sh
vitexec --gpu --path /scene '
  import { keyboard } from "vitexec";
  import { app } from "/src/app.ts";

  await keyboard.down("KeyW");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await keyboard.up("KeyW");

  const { object, camera } = app.getSnapshot();
  console.log("moved", JSON.stringify({ object, camera }));
'
```

```txt
logs:
[log] moved {"object":{"x":0,"y":0,"z":-4.2},"camera":{"yaw":0,"pitch":0}}
```

No debug panel. No test-only app code. No guessing from pixels alone.

## Human-like input

Every script run by the Vitexec CLI can import `mouse` and `keyboard`. The
facade runs in the page while its actions are delivered by Playwright, so the
app receives trusted Chromium events instead of synthetic DOM events.

```sh
vitexec --gpu play.ts
```

```ts
import { keyboard, mouse } from "vitexec";

await mouse.moveTo(640, 360);
await mouse.click();
await keyboard.down("KeyW", { releaseAfterMs: 300 });
await mouse.move(200, 0, { durationMs: 300 });
```

`mouse.move` and `moveTo` follow a smooth acceleration curve at 60 Hz with a
1200 px/s speed ceiling. `moveLatest` starts immediately and lets a feedback loop
replace unfinished aim. Non-zero subpixel relative moves become one physical
pixel rather than disappearing. Holds can carry a `releaseAfterMs` deadline, and Vitexec
releases anything still held when the script ends. Pointer lock receives real
`movementX/Y`; acquire it from a trusted `mouse.click()` and verify
`document.pointerLockElement`. The activation click still reaches the app, and
compatible Playwright Chromium builds can grant pointer lock in headless mode.

## Use It For

- Camera controls, pointer lock, drag interactions, and gamepad input
- Three.js scenes, physics simulations, canvas, WebGL, and WebXR
- Zustand, Redux, TanStack Query, or custom runtime stores
- Screenshots, videos, CPU profiles, HARs, traces, and heap snapshots
- Turning vague browser failures into readable logs

## Commands

```sh
vitexec --gpu --path /scene 'console.log(location.pathname)'
vitexec --gpu --path /scene check-scene.ts
```

For a single argument, vitexec first checks the path as written, then checks the
same path under `./vitexec`, and otherwise treats it as inline code. Thus
`vitexec check-scene.ts` runs `./vitexec/check-scene.ts`.

| Option | Use |
|---|---|
| `--path /scene` | Open a specific route |
| `--config ./vite.config.ts` | Use a specific Vite config |
| `--gpu` | Use generic GPU/WebGPU-friendly Chromium flags |
| `--browser-ws-endpoint wss://...` | Connect to a Playwright browser WebSocket endpoint |
| `--browser-expose-network <loopback>` | Expose local network routes to a remote browser |
| `--screenshot ./page.png` | Capture a full-page screenshot |
| `--record ./run.mp4` | Record an MP4 at the viewport size (60 FPS with page audio by default) |
| `--record-fps 30` | Set the recording frame rate |
| `--record-audio` / `--no-record-audio` | Include (default) or omit page audio |
| `--cpu-profile ./cpu.cpuprofile` | Capture a Chrome/V8 CPU profile |
| `--network-trace ./network.har` | Capture network requests as HAR |
| `--performance-trace ./performance.trace.json` | Capture a Chrome performance trace |
| `--heap-snapshot ./heap.json` | Capture a jq-friendly decoded heap snapshot |
| `--viewport 390x844` | Set the browser viewport (default 1280x720) |
| `--timeout 30` | Set the maximum wait time |

## Environment Variables

CLI flags take precedence over environment variables.

| Environment variable | Equivalent option |
|---|---|
| `VITEXEC_BROWSER_WS_ENDPOINT` | `--browser-ws-endpoint` |
| `VITEXEC_BROWSER_EXPOSE_NETWORK` | `--browser-expose-network` |
| `VITEXEC_CONFIG` | `--config` |
| `VITEXEC_PATH` | `--path` |
| `VITEXEC_GPU` | `--gpu` |
| `VITEXEC_TIMEOUT` | `--timeout` |
| `VITEXEC_SCREENSHOT` | `--screenshot` |
| `VITEXEC_RECORD` | `--record` |
| `VITEXEC_RECORD_FPS` | `--record-fps` |
| `VITEXEC_RECORD_AUDIO` | `--record-audio` / `--no-record-audio` |
| `VITEXEC_CPU_PROFILE` | `--cpu-profile` |
| `VITEXEC_NETWORK_TRACE` | `--network-trace` |
| `VITEXEC_PERFORMANCE_TRACE` | `--performance-trace` |
| `VITEXEC_HEAP_SNAPSHOT` | `--heap-snapshot` |
| `VITEXEC_VIEWPORT` | `--viewport` |

When `--browser-ws-endpoint` is set, vitexec only sends browser-generic
GPU/WebGPU launch flags. Start the remote Playwright server with any
host-specific GPU policy that matches its platform.

## Persistent CLI sessions

```sh
vitexec open game                      # foreground owner; streams page logs
vitexec run game scripts/setup.ts      # another terminal or agent tool call
vitexec run game scripts/play.ts       # same document and app state
```

Start `open` using the agent’s background-terminal tool. `run` waits for page
startup automatically; scripts still need to await app-specific readiness.
Sessions are named within the current working directory. Use that same directory
for `open` and `run`. Duplicate live names fail instead of replacing pages.

Separate `run` commands can overlap. Each command waits for its script and prints
its attributed logs. Stop the foreground `open` process with SIGINT or SIGTERM
to interrupt active runs and close its page, browser, and server.

Browser, Vite, path, viewport, touch, and network-trace options belong to `open`.
Screenshot, recording, and profiling options belong to `run`. `--timeout` sets the
navigation budget on `open`. On `run`, it includes connecting, waiting for page
startup, and execution. Connection attempts retry for up to one second (bounded
by `--timeout`); submitted scripts are never retried. Artifact paths are
resolved from the invoking command's working directory.

The existing `vitexec <file-or-code>` command still performs one execution with
automatic cleanup. Use `./open` or `./run` for files whose names match
subcommands. A leading `--` disambiguates literal code from subcommands.

## Programmatic execution

`run` takes a Playwright **page**, source code, and optional execution settings.
It never navigates or closes the supplied page. `openPage` is the owned-app shortcut:

```ts
import { openPage, run } from "vitexec/cli";

const page = await openPage({ root: "/path/to/app", onLog: console.log });
try {
  await run(page, setupCode, { onLog: console.log });
  await run(page, playCode, { onLog: console.log });
} finally {
  await page.close(); // also awaits browser and Vite server cleanup
}
```

`openPage()` creates its server, browser, context, and page. It accepts configuration,
not borrowed resource handles. GPU-friendly flags and audio are enabled by default;
use `gpu: false` or `audio: false` to disable them. The one-shot CLI keeps GPU opt-in.

For explicit ownership, `openServer({ root, configFile })` returns a listening Vite
server with injection enabled, and `openBrowser(options)` returns Chromium:

```ts
import { openServer, openBrowser, run } from "vitexec/cli";

const server = await openServer({ root: "/path/to/app" });
try {
  const browser = await openBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(server.url);
    await run(page, 'console.log(document.title)', { onLog: console.log });
  } finally {
    await browser.close();
  }
} finally {
  await server.close();
}
```

An existing Chromium page can also be supplied directly. Its app must be served
with the `vitexec()` Vite plugin. Browser handles stay in the owning Node process;
CLI sessions communicate with that process instead of serializing a Playwright page.

Scripts run as unique modules through Vite's transforms and aliases. Imports reuse
app state when their module URLs match. Absolute app imports such as `/src/store.ts`
are simplest; relative imports resolve from the synthetic `.vitexec/code/` directory.
Set `moduleExtension: ".ts"` for TypeScript source. Registered scripts are limited
to 1 MiB. This is a development-server API, not injection into arbitrary websites.

### Logs, completion, and concurrency

Use ordinary `console.log`. A page-level Chromium collector examines synchronous
and async call stacks to route identifiable script logs to that run's `onLog`.
Shared-function and timer logs can be attributed when their caller stack survives.
Unattributed or ambiguous logs, app errors, and network diagnostics go to the
`openPage` callback / `vitexec open` output. Late logs from completed scripts also
go there. Callbacks are optional; omitted callbacks discard their output.

This is stack attribution, not complete causality. In particular, app logs triggered
by physical Playwright input may have no script frame. Inspect the owner output when
an action produces unexpected app behavior. CDP attribution requires Chromium.

`run` resolves when module execution and capture cleanup finish. Scripts should
await their work. Script exceptions, callback failures, and timeouts reject the
promise and make the CLI exit nonzero. Timeout stops waiting, not arbitrary browser
JavaScript: after a timeout, close and reopen the page before another run.

Concurrent runs share DOM, globals, and input. Use `Promise.all` or separate CLI
calls to observe while driving. Only one run may own input at a time; another driver
fails clearly. Input is released when its owner finishes, without disturbing
observers. Input calls must retain a stack identifying their active script.
Overlapping recording/profiling requests are rejected; screenshots capture the
shared page at the moment they are taken.

`createBrowser` and `createServer` remain aliases at the published compatibility
boundary. The deprecated `runVitexec` async generator wraps `openPage` and `run`,
streams their logs, and closes the page when iteration ends. Errors reject iteration;
scripts are not restarted after navigation. For a page you already own, use `run(page, ...)`. New code should use `openPage`, `run(page, ...)`,
and `page.close()`; the CLI uses this new lifecycle too.

See the [three-level game example](./examples/level-injection) for successive
keyboard, clicking, and dragging scripts in one page.
