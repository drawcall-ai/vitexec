# Strict-mode benchmark: battle royale round 1

Measures `vitexec --strict` and its skill the way they will be used: a fresh
agent gets the Drawcall Market `battle-royale` template (its own vitexec
scripts removed), the vitexec skill, and the prompt in
[subagent-prompt.md](subagent-prompt.md). Success is the in-game match time at
the round-1 win and the player's shooting accuracy.

The game needs a GPU and real pointer lock, and several browsers cannot hold
pointer lock on one Mac, so the app runs on a Modal T4 while the agent works
on a local copy of the template.

## Pieces

- `harness.py`: Modal app. Image = template + this package (`vitexec.tgz`,
  from `pnpm pack`) + `accuracy.ts` injected after the app's entry module. One
  `run(script, extension, args)` method executes `npx vitexec` in the pristine
  template and streams its lines; `exec(script)` runs a Node script there for
  diagnostics. The GPU flags, CPU reservation, dependency pre-bundling, and
  enter-time warm-up each fixed a real failure mode; see the comments.
- `client.py`: replaces `node_modules/.bin/vitexec` in the agent's template
  copy. Ships only the script file to the remote run, refuses anything but
  `--strict`, forwards `--path`, `--timeout`, `--viewport`, `--screenshot`,
  `--record`, and writes the `[harness]` instrumentation lines to
  `harness.log` instead of the agent's terminal. App edits by the agent never
  reach the run.
- `accuracy.ts`: counts rounds fired and player hits/kills by wrapping
  `InventorySystem.consumeRound` and `AndroidSystem.damage`; logs one
  `[harness]` JSON line per second and a final one when the match ends.
- `summarize.py [first-run-index]`: last instrumentation line per run.
- `smoke.ts`: a strict script that boots, drops, locks the pointer, measures
  yaw per pixel, moves, and proves a write is rejected. Run it several times
  in a row after any harness change.

## Setup

```sh
npx @drawcall/market install battle-royale --cwd <template>   # pristine copy
rm -rf <template>/vitexec
pnpm --filter vitexec build && pnpm --filter vitexec pack --pack-destination .
mv vitexec-*.tgz vitexec.tgz
modal deploy harness.py                                        # ~3 min first time
cp -R <template> <template copy>; rm -rf <template copy>/vitexec
(cd <template copy> && npm i --no-save ../vitexec.tgz && rm node_modules/.bin/vitexec \
  && printf '#!/bin/sh\nexec python client.py "$@"\n' > node_modules/.bin/vitexec && chmod +x node_modules/.bin/vitexec)
```

Then launch a fresh agent with `subagent-prompt.md` (paths filled in) and read
`summarize.py` afterwards. Stop the app when done: `modal app stop vitexec-harness`
(it keeps one T4 warm).

## Results (2026-09-02, two fresh general-purpose agents, same prompt)

| Agent | Runs | Win | Match time | Shots / hits | Accuracy | Wall time |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 5 (1 lost to a harness boot stall) | 4th run | 24.5 s | 37 / 24 | 65% | 35 min |
| 2 | 3 | 3rd run | 20.7 s | 36 / 24 | 67% | 17 min |

Target was under 45 s at 80% accuracy. The earlier verifier-based design
(#4) reached first-attempt wins at 115 to 223 s of match time with a hand-tuned
controller handed to the agent.
