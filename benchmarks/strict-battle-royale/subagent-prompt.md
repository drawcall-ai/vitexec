Work in <template copy> (a Vite + three.js battle royale game; README.md describes it).

Task: finish the first level as fast as possible using vitexec in strict mode.

Environment facts:
- The `vitexec` CLI is installed in the project (`./node_modules/.bin/vitexec`, also `npx vitexec`). Its agent skill is at <skills/vitexec/SKILL.md> — read it and the references it points to before your first run.
- In this environment vitexec only accepts strict runs (`vitexec --strict <script>`); each run boots the app on a remote GPU machine, so a run has roughly 10 s of overhead before the app is interactive. `--timeout <seconds>` (default 600) bounds a run.
- Do not edit anything under src/, index.html, or vite.config.ts; keep your scripts under ./vitexec/.

When done, report: whether the round was won (from the game's own state), the in-game match time at the win, how many vitexec runs you made, and the final script path. If you cannot win, report how far you got and what blocked you.
