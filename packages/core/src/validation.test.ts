import { describe, expect, it } from "vitest";
import { fail, ok } from "./result.js";
import type { ValidationResult } from "./validation.js";
import { isCompatibleSchemaVersion } from "./validation.js";

describe("ValidationResult", () => {
  it("accepts an ok result with a value", () => {
    const result: ValidationResult<string> = ok("valid");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("valid");
    }
  });

  it("accepts a fail result with ValidationFailure", () => {
    const result: ValidationResult<string> = fail({
      errors: [{ path: "name", message: "required" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.errors).toHaveLength(1);
      expect(result.failure.errors[0]).toEqual({ path: "name", message: "required" });
    }
  });
});

describe("isCompatibleSchemaVersion", () => {
  it("returns true when actual equals expected", () => {
    expect(isCompatibleSchemaVersion(1, 1)).toBe(true);
  });

  it("returns false when actual differs from expected", () => {
    expect(isCompatibleSchemaVersion(2, 1)).toBe(false);
    expect(isCompatibleSchemaVersion(0, 1)).toBe(false);
  });
});
