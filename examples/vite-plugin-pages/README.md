# Vite plugin pages

This example uses the `vitexec()` Vite plugin without the vitexec CLI. Its
top-level `./vitexec` files become normal app routes:

| Source | Route |
|---|---|
| `vitexec/smoke.ts` | `/smoke.html` |
| `vitexec/checkout.ts` | `/checkout.html` |

Run the development server:

```sh
pnpm --filter vite-plugin-pages dev
```

Open `/`, `/smoke.html`, and `/checkout.html`.

Build and serve the production output:

```sh
pnpm --filter vite-plugin-pages build
pnpm --filter vite-plugin-pages preview
```

The same three routes show the same app and script results. There is no custom
dev server or vitexec CLI script; both modes use the normal Vite commands from
`package.json`.
