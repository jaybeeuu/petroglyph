import { describe, expect, it } from "vitest";
import { fail, isFail, isOk, ok } from "./result.js";

describe("ok", () => {
  it("returns a Success with ok: true and the given value", () => {
    const result = ok("hello");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("hello");
  });
});

describe("fail", () => {
  it("returns a Failure with ok: false and the given reason", () => {
    const result = fail({ code: "NOT_FOUND" });
    expect(result.ok).toBe(false);
    expect(result.failure).toEqual({ code: "NOT_FOUND" });
  });
});

describe("isOk", () => {
  it("returns true for a Success result", () => {
    expect(isOk(ok(42))).toBe(true);
  });

  it("returns false for a Failure result", () => {
    expect(isOk(fail("err"))).toBe(false);
  });
});

describe("isFail", () => {
  it("returns true for a Failure result", () => {
    expect(isFail(fail("err"))).toBe(true);
  });

  it("returns false for a Success result", () => {
    expect(isFail(ok(42))).toBe(false);
  });
});
