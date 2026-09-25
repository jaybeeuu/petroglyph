import { describe, expect, it } from "vitest";
import { detectType } from "./type.js";

const bytes = (input: string): Uint8Array => new TextEncoder().encode(input);

describe("detectType", () => {
  it("detects a PDF body from its %PDF- signature", () => {
    expect(detectType(bytes("%PDF-1.7\n%ÿÿÿÿ\n1 0 obj"))).toBe("application/pdf");
  });

  it("returns null for HTML bodies", () => {
    expect(detectType(bytes("<!DOCTYPE html><html>"))).toBeNull();
  });

  it("returns null for JPEG bodies", () => {
    expect(detectType(bytes("\u{FFD8}\u{FFE0}\u{0010}JFIF"))).toBeNull();
  });

  it("returns null for an empty body", () => {
    expect(detectType(new Uint8Array(0))).toBeNull();
  });

  it("returns null when the signature is not at the start of the body", () => {
    expect(detectType(bytes("\u0000\u0000\u0000\u0000%PDF-1.7"))).toBeNull();
    expect(detectType(bytes(" \n%PDF-1.7"))).toBeNull();
  });

  it("never yields a PDF type for bytes that do not verify — the claim is pinned", () => {
    expect(detectType(bytes("abc"))).toBeNull();
    expect(detectType(bytes("%PDX-"))).toBeNull();
  });
});
