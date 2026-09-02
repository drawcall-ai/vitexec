// Harness-only instrumentation (lives in the pristine remote copy, not in the
// agent's copy): counts rounds fired and hits landed by the player, and logs a
// [harness] line every second plus a final one when the match ends.
import { InventorySystem } from '/src/combat/inventory.ts'
import { AndroidSystem } from '/src/combat/androids.ts'
import { gameState } from '/src/game/state.ts'

let shots = 0
let hits = 0
let kills = 0

const consumeRound = InventorySystem.prototype.consumeRound
InventorySystem.prototype.consumeRound = function (this: InventorySystem) {
  shots += 1
  return consumeRound.call(this)
}

const damage = AndroidSystem.prototype.damage
AndroidSystem.prototype.damage = function (this: AndroidSystem, bot, amount, cause, killerTag) {
  const result = damage.call(this, bot, amount, cause, killerTag)
  if (cause === 'player') {
    hits += 1
    if (result.killed) kills += 1
  }
  return result
}

let finished = false
const report = (final: boolean) => {
  const line = JSON.stringify({
    phase: gameState.phase,
    won: gameState.won,
    matchTime: Math.round(gameState.matchTime * 100) / 100,
    shots,
    hits,
    kills,
    accuracy: shots ? Math.round((hits / shots) * 1000) / 10 : null,
    final,
  })
  console.log(`[harness] ${line}`)
}
window.setInterval(() => {
  if (finished) return
  if (gameState.phase === 'over') {
    finished = true
    report(true)
    return
  }
  report(false)
}, 1000)
