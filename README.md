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
  import { app } from "/src/app.ts";

  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));

  const { object, camera } = app.getSnapshot();
  console.log("moved", JSON.stringify({ object, camera }));
'
```

```txt
logs:
[log] moved {"object":{"x":0,"y":0,"z":-4.2},"camera":{"yaw":0,"pitch":0}}
```

No debug panel. No test-only app code. No guessing from pixels alone.

## Use It For

- Camera controls, pointer lock, drag interactions, and gamepad input
- Three.js scenes, physics simulations, canvas, WebGL, and WebXR
- Zustand, Redux, TanStack Query, or custom runtime stores
- Screenshots, videos, CPU profiles, HARs, traces, and heap snapshots
- Turning vague browser failures into readable logs

## Commands

```sh
vitexec --gpu --path /scene 'console.log(location.pathname)'
vitexec --gpu --path /scene ./vitexec/check-scene.ts
```

| Option | Use |
|---|---|
| `--path /scene` | Open a specific route |
| `--config ./vite.config.ts` | Use a specific Vite config |
| `--gpu` | Use generic GPU/WebGPU-friendly Chromium flags |
| `--browser-ws-endpoint wss://...` | Connect to a Playwright browser WebSocket endpoint |
| `--browser-expose-network <loopback>` | Expose local network routes to a remote browser |
| `--screenshot ./page.png` | Capture a full-page screenshot |
| `--record ./run.webm` | Record browser video |
| `--cpu-profile ./cpu.cpuprofile` | Capture a Chrome/V8 CPU profile |
| `--network-trace ./network.har` | Capture network requests as HAR |
| `--performance-trace ./performance.trace.json` | Capture a Chrome performance trace |
| `--heap-snapshot ./heap.json` | Capture a jq-friendly decoded heap snapshot |
| `--keep-browser-open` | Leave a `--browser-ws-endpoint` browser running after the run |
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
| `VITEXEC_CPU_PROFILE` | `--cpu-profile` |
| `VITEXEC_NETWORK_TRACE` | `--network-trace` |
| `VITEXEC_PERFORMANCE_TRACE` | `--performance-trace` |
| `VITEXEC_HEAP_SNAPSHOT` | `--heap-snapshot` |
| `VITEXEC_KEEP_BROWSER_OPEN` | `--keep-browser-open` |

When `--browser-ws-endpoint` is set, vitexec only sends browser-generic
GPU/WebGPU launch flags. Start the remote Playwright server with any
host-specific GPU policy that matches its platform.

## Run inside a browser you already have (page adoption)

By default vitexec launches its own Chromium. When you call it programmatically
you can instead hand it a browser/context/page you already own — so the snippet
runs in **that** browser with **no second window**. This is ideal when a dev
server already opens a visible, instrumented tab (e.g. a WebXR emulator) and you
want to watch the check run live in it.

```ts
import { runVitexec, runVitexecOnPage } from "vitexec/dist/cli.js";

// Adopt an existing Playwright Page (same process). vitexec navigates it to its
// own injected URL, runs the snippet, and never closes the page/context/browser.
for await (const line of runVitexecOnPage(code, page, { root })) console.log(line);

// Or pass handles directly:
runVitexec(code, { root, page });                 // reuse this page
runVitexec(code, { root, context });              // open a fresh page in this context
runVitexec(code, { root, browser });              // open a fresh context+page in this browser
runVitexec(code, { root, adoptPage: () => page }); // thunk resolved AFTER the server is listening
```

`adoptPage` is a thunk so a caller that opens the browser *in reaction to*
vitexec's own dev server starting (a Vite plugin launching a browser on
`listening`) can hand the page over once it exists.

Ownership is automatic: when a page/context/browser is adopted, vitexec reuses it
and never closes it (`keepBrowserOpen` is implied) — it only ever closes handles
it created itself, and always closes its own Vite server. On the
`--browser-ws-endpoint` path, set `keepBrowserOpen` to leave a `launchServer`
browser running between runs.

vitexec still serves the snippet from its own Vite server (that is where the
injected module lives), so an adopted page is navigated to vitexec's per-run URL.
A re-used page is safe to drive across many sequential runs.
