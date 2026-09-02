import type { InputMouseButton, InputPhysicalCommand } from "./types.js";

export function parseInputCommand(value: unknown): InputPhysicalCommand {
  if (!isRecord(value)) throw new Error("Vitexec input command must be an object.");
  const type = requiredString(value, "type");

  switch (type) {
    case "wait":
      exactKeys(value, ["durationMs", "type"]);
      return { type, durationMs: requiredPositiveNumber(value, "durationMs") };
    case "keyboard.down": {
      exactKeys(value, ["key", "releaseAfterMs", "type"]);
      const releaseAfterMs = optionalPositiveNumber(value, "releaseAfterMs");
      return {
        type,
        key: requiredKeyboardKey(value, "key"),
        ...(releaseAfterMs === undefined ? {} : { releaseAfterMs })
      };
    }
    case "keyboard.up":
      exactKeys(value, ["key", "type"]);
      return { type, key: requiredKeyboardKey(value, "key") };
    case "keyboard.press":
      exactKeys(value, ["durationMs", "key", "type"]);
      return {
        type,
        durationMs: requiredPositiveNumber(value, "durationMs"),
        key: requiredKeyboardKey(value, "key")
      };
    case "mouse.click": {
      const button = optionalMouseButton(value, "button");
      if ("target" in value) {
        exactKeys(value, ["button", "target", "type"]);
        return {
          type,
          target: requiredString(value, "target"),
          ...(button ? { button } : {})
        };
      }
      exactKeys(value, ["button", "type", "x", "y"]);
      return {
        type,
        x: requiredNumber(value, "x"),
        y: requiredNumber(value, "y"),
        ...(button ? { button } : {})
      };
    }
    case "mouse.down": {
      exactKeys(value, ["button", "releaseAfterMs", "type"]);
      const button = optionalMouseButton(value, "button");
      const releaseAfterMs = optionalPositiveNumber(value, "releaseAfterMs");
      return {
        type,
        ...(button ? { button } : {}),
        ...(releaseAfterMs === undefined ? {} : { releaseAfterMs })
      };
    }
    case "mouse.up": {
      exactKeys(value, ["button", "type"]);
      const button = optionalMouseButton(value, "button");
      return { type, ...(button ? { button } : {}) };
    }
    case "mouse.press": {
      exactKeys(value, ["button", "durationMs", "type"]);
      const button = optionalMouseButton(value, "button");
      return {
        type,
        durationMs: requiredPositiveNumber(value, "durationMs"),
        ...(button ? { button } : {})
      };
    }
    case "mouse.move":
      exactKeys(value, ["deltaX", "deltaY", "durationMs", "type"]);
      return {
        type,
        deltaX: requiredNumber(value, "deltaX"),
        deltaY: requiredNumber(value, "deltaY"),
        durationMs: requiredPositiveNumber(value, "durationMs")
      };
    case "mouse.moveTo":
      exactKeys(value, ["durationMs", "type", "x", "y"]);
      return {
        type,
        durationMs: requiredPositiveNumber(value, "durationMs"),
        x: requiredNumber(value, "x"),
        y: requiredNumber(value, "y")
      };
    case "mouse.moveLatest":
      if ("deltaX" in value || "deltaY" in value) {
        exactKeys(value, ["deltaX", "deltaY", "type"]);
        return {
          deltaX: requiredNumber(value, "deltaX"),
          deltaY: requiredNumber(value, "deltaY"),
          type
        };
      }
      exactKeys(value, ["type", "x", "y"]);
      return {
        type,
        x: requiredNumber(value, "x"),
        y: requiredNumber(value, "y")
      };
    case "mouse.stop":
      exactKeys(value, ["type"]);
      return { type };
    default:
      throw new Error(`Unsupported Vitexec input command: ${type}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpected) throw new Error(`Unexpected Vitexec input field: ${unexpected}`);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`Vitexec input field "${key}" must be a non-empty string.`);
  }
  return field;
}

function requiredKeyboardKey(value: Record<string, unknown>, key: string): string {
  return requiredString(value, key);
}

function requiredNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`Vitexec input field "${key}" must be a finite number.`);
  }
  return field;
}

function requiredPositiveNumber(value: Record<string, unknown>, key: string): number {
  const field = requiredNumber(value, key);
  if (field <= 0) throw new Error(`Vitexec input field "${key}" must be positive.`);
  return field;
}

function optionalPositiveNumber(
  value: Record<string, unknown>,
  key: string
): number | undefined {
  if (value[key] === undefined) return undefined;
  return requiredPositiveNumber(value, key);
}

function optionalMouseButton(
  value: Record<string, unknown>,
  key: string
): InputMouseButton | undefined {
  const field = value[key];
  if (field === undefined) return undefined;
  if (field === "left" || field === "middle" || field === "right") return field;
  throw new Error(`Vitexec input field "${key}" must be left, middle, or right.`);
}
