<div align="center">
  <img src="./assets/vitexec-header.svg" alt="vitexec header" />
</div>

## Quickstart

Install the skill:

```sh
npx skills add drawcall-ai/vitexec
```

Then ask your agent:

```txt
Use $vitexec to inspect the cart state after clicking add to cart.
```

You click through a checkout flow. The UI looks right. But did the client store update?

```sh
vitexec --path /cart '
  import { useCartStore } from "/src/stores/cart.ts";

  document.querySelector("[data-testid=add-to-cart]")?.click();
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const { items, total } = useCartStore.getState();
  console.log("cart", JSON.stringify({ count: items.length, total }));
'
```

```txt
logs:
[log] cart {"count":1,"total":49}
```

No temporary test page. No debug panel. No guessing from the DOM.

## Use It For

- Reading Zustand, Redux, or app state after user interactions
- Inspecting exported objects from the Vite module graph
- Checking canvas, WebGL, and Three.js scenes in the browser
- Capturing screenshots from a live page
- Turning vague browser failures into readable logs

## Commands

```sh
vitexec --path /cart --screenshot ./artifacts/cart.png '
  console.log("ready");
'
```

| Option | Use |
|---|---|
| `--path /cart` | Open a specific route |
| `--config ./vite.config.ts` | Use a specific Vite config |
| `--timeout 30` | Set the maximum wait time |
| `--gpu` | Use GPU-friendly Chromium flags |
| `--screenshot ./page.png` | Capture a full-page screenshot |
| `--record ./run.webm` | Record browser video |
| `--cpu-profile ./cpu.cpuprofile` | Capture a Chrome/V8 CPU profile |
| `--network-trace ./network.har` | Capture network requests as HAR |
| `--performance-trace ./performance.trace.json` | Capture a Chrome performance trace |
| `--heap-snapshot ./heap.json` | Capture a jq-friendly decoded heap snapshot |

The skill explains when to use `vitexec`, how to install it if missing, and how to write focused snippets that return useful logs and performance artifacts.

## TODO
[ ] support sth. like import { pause, resume, advance } from "vitexec/request-animation-frame" (maybe even also support override perfomance.now?)
[ ] make sure the raf pausing etc also works for WebXR
