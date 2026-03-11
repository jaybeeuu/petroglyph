import { describe, expect, it } from "vitest";
import { fail, isFail, isOk, ok } from "./result.js";

describe("ok", () => {
  it("returns a Result with ok: true and the given value", () => {
    const result = ok("hello");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("hello");
    }
  });
});

describe("fail", () => {
  it("returns a Result with ok: false and the given failure", () => {
    const result = fail({ code: "NOT_FOUND" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toEqual({ code: "NOT_FOUND" });
    }
  });
});

describe("isOk", () => {
  it("returns true for an ok result", () => {
    expect(isOk(ok(42))).toBe(true);
  });

  it("returns false for a fail result", () => {
    expect(isOk(fail("err"))).toBe(false);
  });
});

describe("isFail", () => {
  it("returns true for a fail result", () => {
    expect(isFail(fail("err"))).toBe(true);
  });

  it("returns false for an ok result", () => {
    expect(isFail(ok(42))).toBe(false);
  });
});
