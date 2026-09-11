import { describe, expect, it } from "vitest";
import { decodeFeedCursor, encodeFeedCursor } from "./cursor.js";

describe("feed cursor", () => {
  it("round-trips an opaque cursor token", () => {
    const cursor = { profileId: "p1", itemId: "item-42" };
    expect(decodeFeedCursor(encodeFeedCursor(cursor))).toEqual(cursor);
  });

  it("rejects tokens that are not valid cursors", () => {
    expect(() => decodeFeedCursor("not-base64url-json")).toThrow();
    expect(() => decodeFeedCursor(encodeFeedCursor({ profileId: "", itemId: "x" }))).toThrow();
    expect(() => decodeFeedCursor(encodeFeedCursor({ profileId: "p1", itemId: "" }))).toThrow();
  });
});
