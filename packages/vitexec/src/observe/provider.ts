import type {
  ObservationPrimitiveKind,
  ObservationPathSegment,
  ObservationProjection,
  ObservationProjectionResult,
  ObservationProvider,
  ObservationValue
} from "./types.js";
import { MAXIMUM_OBSERVATION_SNAPSHOT_BYTES } from "./policy.js";
import { validateObservationProjection } from "./fields.js";

type ActiveObservationProvider = {
  snapshot: () => string;
};

let activeProvider: ActiveObservationProvider | undefined;

function selectedValue(
  root: unknown,
  path: readonly ObservationPathSegment[],
  optional: boolean
): unknown {
  let value = root;
  const traversed: ObservationPathSegment[] = [];
  for (const segment of path) {
    if (typeof value !== "object" || value === null) {
      const received = value === null ? "null" : typeof value;
      throw new Error(
        `Observation path ${JSON.stringify(path)} encountered ${received} at ` +
        `${JSON.stringify(traversed)} before ${JSON.stringify(segment)}.`
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, segment);
    if (!descriptor) {
      if (optional) return null;
      throw new Error(`Observation path requires an own data property ${JSON.stringify(String(segment))}.`);
    }
    if (!("value" in descriptor)) {
      throw new Error(`Observation path requires an own data property ${JSON.stringify(String(segment))}.`);
    }
    value = descriptor.value;
    traversed.push(segment);
  }
  return value;
}

function parseSnapshot(serialized: string): unknown {
  if (serialized.length > MAXIMUM_OBSERVATION_SNAPSHOT_BYTES) {
    throw new Error(
      `Observation snapshot exceeds ${MAXIMUM_OBSERVATION_SNAPSHOT_BYTES} bytes.`
    );
  }
  try {
    const result: unknown = JSON.parse(serialized);
    return result;
  } catch (error) {
    throw new Error("Observation provider returned invalid JSON.", { cause: error });
  }
}

function formatSnapshot(snapshot: unknown): string {
  const formatted = JSON.stringify(snapshot, null, 2);
  if (typeof formatted !== "string") {
    throw new Error("Observation snapshot could not be formatted as JSON.");
  }
  return formatted;
}

function validatedPrimitive(
  value: unknown,
  kind: ObservationPrimitiveKind,
  key: string,
  nullable: boolean
): ObservationValue {
  if (value === null && nullable) return null;
  if (typeof value !== kind) {
    const received = value === null ? "null" : typeof value;
    throw new Error(`Observation field ${JSON.stringify(key)} expected ${kind}, received ${received}.`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`Observation field ${JSON.stringify(key)} must be finite.`);
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  throw new Error(`Observation field ${JSON.stringify(key)} was not primitive.`);
}

export function installObservationProvider(provider: ObservationProvider): () => void {
  if (typeof provider !== "object" || provider === null || Array.isArray(provider) ||
    typeof provider.snapshot !== "function") {
    throw new Error("Vitexec observation provider must contain a snapshot function.");
  }
  if (activeProvider) {
    throw new Error("A Vitexec observation provider is already installed.");
  }
  activeProvider = {
    snapshot: provider.snapshot.bind(provider)
  };
  let installed = true;
  return () => {
    if (!installed) return;
    installed = false;
    activeProvider = undefined;
  };
}

export function observe(): string;
export function observe<Projection extends ObservationProjection>(
  projection: Projection
): ObservationProjectionResult<Projection>;
export function observe(
  projection?: ObservationProjection
): Readonly<Record<string, ObservationValue>> | string {
  const provider = activeProvider;
  if (!provider) {
    throw new Error("Vitexec observation is unavailable: no trusted read-only provider is installed.");
  }
  const fields = projection === undefined ? undefined : validateObservationProjection(projection);
  const serialized = provider.snapshot();
  if (typeof serialized !== "string") {
    throw new Error("Observation provider must return a serialized JSON snapshot.");
  }
  const snapshot = parseSnapshot(serialized);
  if (!fields) return formatSnapshot(snapshot);
  const result: Record<string, ObservationValue> = {};
  Object.setPrototypeOf(result, null);
  for (const [key, field] of fields) {
    result[key] = validatedPrimitive(
      selectedValue(snapshot, field.path, field.optional),
      field.kind,
      key,
      field.nullable
    );
  }
  return Object.freeze(result);
}
