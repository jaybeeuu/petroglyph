import { describe, expect, it } from "vitest";
import { tokenRecordSchema } from "./token-store.js";

const VALID_RECORD = {
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expirySeconds: 1_000_000,
  updatedAt: "2026-09-01T00:00:00.000Z",
  reconnectRequired: false,
};

describe("tokenRecordSchema", () => {
  it("accepts a well-formed persisted record", () => {
    expect(tokenRecordSchema.parse(VALID_RECORD)).toEqual(VALID_RECORD);
  });

  it("rejects an empty access token", () => {
    expect(tokenRecordSchema.safeParse({ ...VALID_RECORD, accessToken: "" }).success).toBe(false);
  });

  it("rejects a non-positive, non-integer expiry", () => {
    expect(tokenRecordSchema.safeParse({ ...VALID_RECORD, expirySeconds: 0 }).success).toBe(false);
    expect(tokenRecordSchema.safeParse({ ...VALID_RECORD, expirySeconds: 1.5 }).success).toBe(
      false,
    );
  });

  it("rejects a record missing reconnectRequired (the sticky grant flag)", () => {
    const { reconnectRequired: _unused, ...withoutFlag } = VALID_RECORD;
    expect(tokenRecordSchema.safeParse(withoutFlag).success).toBe(false);
  });
});
