import { describe, it, expect } from "vitest";
import { MockAuthProvider, MOCK_OID, MOCK_TID, MOCK_SUB } from "./mock-provider.js";
import { isOk } from "@petroglyph/core";

describe("MockAuthProvider", () => {
  it("returns ok with valid synthetic claims for any non-empty token", async () => {
    const provider = new MockAuthProvider();
    const result = await provider.validateToken("any-token-value");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.oid).toBe(MOCK_OID);
      expect(result.value.tid).toBe(MOCK_TID);
      expect(result.value.sub).toBe(MOCK_SUB);
    }
  });

  it("includes an exp in the future", async () => {
    const provider = new MockAuthProvider();
    const result = await provider.validateToken("token");
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  it("always returns ok (mock never rejects tokens)", async () => {
    const provider = new MockAuthProvider();
    const result = await provider.validateToken("whatever");
    expect(isOk(result)).toBe(true);
  });
});
