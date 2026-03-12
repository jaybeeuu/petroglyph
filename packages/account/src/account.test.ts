import { describe, expect, it } from "vitest";
import {
  AccountStatusSchema,
  ApplicationUserSchema,
  AuthIdentitySchema,
} from "./account.js";

const validTimestamp = "2026-03-11T12:00:00.000Z";

describe("AccountStatusSchema", () => {
  it.each([{ value: "active" }, { value: "disabled" }])(
    "accepts '$value'",
    ({ value }) => {
      expect(AccountStatusSchema.safeParse(value).success).toBe(true);
    },
  );

  it("rejects unknown status values", () => {
    expect(AccountStatusSchema.safeParse("suspended").success).toBe(false);
  });
});

describe("ApplicationUserSchema", () => {
  it("parses a valid active user", () => {
    const result = ApplicationUserSchema.safeParse({
      id: "user-1",
      status: "active",
      displayName: "Alice",
      createdAt: validTimestamp,
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid disabled user", () => {
    const result = ApplicationUserSchema.safeParse({
      id: "user-2",
      status: "disabled",
      displayName: "Bob",
      createdAt: validTimestamp,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(ApplicationUserSchema.safeParse({ id: "user-1" }).success).toBe(false);
  });

  it("rejects an invalid status", () => {
    const result = ApplicationUserSchema.safeParse({
      id: "user-1",
      status: "suspended",
      displayName: "Alice",
      createdAt: validTimestamp,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-datetime createdAt", () => {
    const result = ApplicationUserSchema.safeParse({
      id: "user-1",
      status: "active",
      displayName: "Alice",
      createdAt: "not-a-date",
    });
    expect(result.success).toBe(false);
  });
});

describe("AuthIdentitySchema", () => {
  it("parses a valid identity without an email", () => {
    const result = AuthIdentitySchema.safeParse({
      id: "identity-1",
      userId: "user-1",
      provider: "entra",
      externalId: "ext-abc-123",
      createdAt: validTimestamp,
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid identity with an email", () => {
    const result = AuthIdentitySchema.safeParse({
      id: "identity-2",
      userId: "user-1",
      provider: "entra",
      externalId: "ext-abc-123",
      externalEmail: "alice@example.com",
      createdAt: validTimestamp,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(AuthIdentitySchema.safeParse({ id: "identity-1" }).success).toBe(false);
  });
});
