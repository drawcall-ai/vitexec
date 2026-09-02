import type { InputPhysicalCommand, InputResult } from "./types.js";

export const VITEXEC_INPUT_BINDING = "__vitexecInput_v1__";

export type InputBindingResult = InputResult;

type VitexecInputBinding = (
  command: InputPhysicalCommand
) => Promise<InputBindingResult>;

declare global {
  var __vitexecInput_v1__: VitexecInputBinding | undefined;
}
