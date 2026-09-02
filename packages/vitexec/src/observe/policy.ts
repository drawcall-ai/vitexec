export const FORBIDDEN_OBSERVATION_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);

export const OBSERVATION_KINDS = new Set(["boolean", "number", "string"]);
export const MAXIMUM_OBSERVATION_FIELDS = 32;
export const MAXIMUM_OBSERVATION_PATH_DEPTH = 16;
export const MAXIMUM_OBSERVATION_SNAPSHOT_BYTES = 1_000_000;
