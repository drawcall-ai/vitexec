import type {
  ObservationPathSegment,
  ObservationPrimitiveKind
} from "./types.js";
import {
  FORBIDDEN_OBSERVATION_KEYS,
  MAXIMUM_OBSERVATION_FIELDS,
  MAXIMUM_OBSERVATION_PATH_DEPTH
} from "./policy.js";

export type ValidatedObservationField = {
  kind: ObservationPrimitiveKind;
  nullable: boolean;
  optional: boolean;
  path: ObservationPathSegment[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertyName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 ||
    FORBIDDEN_OBSERVATION_KEYS.has(value)) {
    throw new Error(`${label} must be a non-empty safe property name.`);
  }
  return value;
}

function pathSegment(value: unknown, label: string): ObservationPathSegment {
  if (typeof value === "string") return propertyName(value, label);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`${label} must be a safe property name or non-negative integer.`);
}

function fieldKind(value: unknown, label: string): ObservationPrimitiveKind {
  if (value === "boolean" || value === "number" || value === "string") return value;
  throw new Error(`${label} must be "boolean", "number", or "string".`);
}

function fieldPath(value: unknown, label: string): ObservationPathSegment[] {
  if (!Array.isArray(value) || value.length === 0 ||
    value.length > MAXIMUM_OBSERVATION_PATH_DEPTH) {
    throw new Error(
      `${label} must contain 1-${MAXIMUM_OBSERVATION_PATH_DEPTH} path segments.`
    );
  }
  return value.map((segment, index) => pathSegment(segment, `${label}[${index}]`));
}

function observationField(value: unknown, label: string): ValidatedObservationField {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an observation field object.`);
  }
  const keys = Object.keys(value);
  const hasNullable = keys.includes("nullable");
  const hasOptional = keys.includes("optional");
  const expectedKeyCount = 2 + Number(hasNullable) + Number(hasOptional);
  if (keys.length !== expectedKeyCount || !keys.includes("kind") || !keys.includes("path")) {
    throw new Error(`${label} must contain kind, path, and optionally nullable and optional.`);
  }
  const nullable = hasNullable ? value.nullable : false;
  if (typeof nullable !== "boolean") {
    throw new Error(`${label}.nullable must be boolean.`);
  }
  const optional = hasOptional ? value.optional : false;
  if (typeof optional !== "boolean") {
    throw new Error(`${label}.optional must be boolean.`);
  }
  if (optional && !nullable) {
    throw new Error(`${label}.optional requires nullable: true.`);
  }
  return {
    kind: fieldKind(value.kind, `${label}.kind`),
    nullable,
    optional,
    path: fieldPath(value.path, `${label}.path`)
  };
}

export function validateObservationProjection(
  value: unknown
): Map<string, ValidatedObservationField> {
  if (!isRecord(value)) {
    throw new Error("Observation projection must be an object.");
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.length > MAXIMUM_OBSERVATION_FIELDS) {
    throw new Error(
      `Observation projection must contain 1-${MAXIMUM_OBSERVATION_FIELDS} fields.`
    );
  }
  const result = new Map<string, ValidatedObservationField>();
  for (const rawKey of keys) {
    const key = propertyName(rawKey, "Observation output key");
    result.set(key, observationField(value[key], `Observation field ${JSON.stringify(key)}`));
  }
  return result;
}
