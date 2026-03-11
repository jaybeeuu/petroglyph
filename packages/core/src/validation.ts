import type { Result } from "./result.js";

export type ValidationError = { path: string; message: string };
export type ValidationFailure = { errors: ValidationError[] };
export type ValidationResult<Value> = Result<Value, ValidationFailure>;

export type SchemaVersion = number & { readonly _brand: "SchemaVersion" };
export const asSchemaVersion = (n: number): SchemaVersion => n as SchemaVersion;

// Checks strict equality between actual and expected schema versions. Two versions are compatible
// only when they are identical. Relaxing this constraint (e.g. semver minor compatibility) should
// be a deliberate, explicit decision rather than the default.
export const isCompatibleSchemaVersion = (actual: number, expected: number): boolean =>
  actual === expected;
