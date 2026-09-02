import type {
  InputBindingResult
} from "./binding.js";
import type {
  InputPhysicalCommand,
  InputResult,
  InputWaitCommand
} from "./types.js";
import { parseInputCommand } from "./parse.js";

export type {
  InputMouseButton,
  InputPhysicalCommand,
  InputResult
} from "./types.js";

async function waitInBrowser(command: InputWaitCommand): Promise<InputResult> {
  await new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, command.durationMs);
  });
  return { status: "completed" };
}

/**
 * Sends one real Playwright-backed keyboard or mouse command.
 *
 * For settled movement, mouse.move and mouse.moveTo resolve after the path
 * settles. For changing feedback, mouse.moveLatest resolves after its first
 * real event and later calls replace unapplied movement. Stateful down and
 * moveLatest commands remain active while later commands run.
 *
 * Each command is validated before dispatch. The runtime owns pointer-movement
 * pacing, interpolation, leases, and physical speed and duration limits.
 * A receipt proves input delivery, not an application state transition.
 */
export function input(command: InputPhysicalCommand): Promise<InputResult>;
export async function input(command: InputPhysicalCommand): Promise<InputBindingResult> {
  const binding = globalThis.__vitexecInput_v1__;
  if (!binding) {
    throw new Error("Vitexec input is unavailable: no trusted Playwright input host is installed.");
  }
  const parsed = parseInputCommand(command);
  if (parsed.type === "wait") return waitInBrowser(parsed);
  return await binding(parsed);
}
