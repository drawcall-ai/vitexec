# Three little challenges

A small game demonstrating three separate script injections into one running
Vite page. The scripts play with real keyboard and mouse input; they only read
`getState()` to check their progress.

1. **Walk:** use arrow keys to go around a wall.
2. **Aim:** click three targets in order.
3. **Deliver:** drag a parcel into its dock.

Play manually:

```sh
pnpm --filter level-injection dev
```

Run the automated example from the repository root:

```sh
pnpm --filter vitexec build
pnpm --filter level-injection play
```

`play.mjs` creates a server and browser, opens the game once, then awaits three
`run(page, code, { onLog: console.log })` calls. Each script plays one level and
checks its result. The browser and server close in `finally`.

`createServer()` enables injection automatically. The `vitexec()` plugin in
`vite.config.ts` also enables it when starting Vite manually.
