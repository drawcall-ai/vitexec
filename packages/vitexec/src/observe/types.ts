export type ObservationPrimitive = boolean | number | string;
export type ObservationValue = ObservationPrimitive | null;
export type ObservationPrimitiveKind = "boolean" | "number" | "string";
export type ObservationPathSegment = number | string;

type ObservationRequiredField = {
  kind: ObservationPrimitiveKind;
  nullable?: false;
  optional?: false;
  path: readonly ObservationPathSegment[];
};

type ObservationNullableField = {
  kind: ObservationPrimitiveKind;
  /** Adds null to the declared primitive; does not permit a container or infer its non-null kind. */
  nullable: true;
  /** Returns null when an own data property in the path is absent. Wrong container types still fail. */
  optional?: boolean;
  path: readonly ObservationPathSegment[];
};

export type ObservationField = ObservationRequiredField | ObservationNullableField;

export type ObservationProjection = Readonly<Record<string, ObservationField>>;

type ObservationKindValue<Kind extends ObservationPrimitiveKind> =
  Kind extends "boolean" ? boolean :
  Kind extends "number" ? number :
  string;

type ObservationFieldValue<Field extends ObservationField> =
  Field extends { readonly nullable: true }
    ? ObservationKindValue<Field["kind"]> | null
    : ObservationKindValue<Field["kind"]>;

export type ObservationProjectionResult<Projection extends ObservationProjection> = {
  readonly [Key in keyof Projection]: ObservationFieldValue<Projection[Key]>;
};

export type ObservationProvider = {
  readonly snapshot: () => string;
};
