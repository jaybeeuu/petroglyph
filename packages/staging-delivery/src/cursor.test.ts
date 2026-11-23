import { describe, expect, it } from "vitest";
import { decodeFeedCursor, encodeFeedCursor } from "./cursor.js";

describe("feed cursor", () => {
  it("round-trips an opaque cursor token carrying the log seq", () => {
    const cursor = { profileId: "p1", seq: 42 };
    expect(decodeFeedCursor(encodeFeedCursor(cursor))).toEqual(cursor);
  });

  it("rejects tokens that are not valid cursors", () => {
    expect(() => decodeFeedCursor("not-base64url-json")).toThrow();
    expect(() => decodeFeedCursor(encodeFeedCursor({ profileId: "", seq: 1 }))).toThrow();
    expect(() => decodeFeedCursor(encodeFeedCursor({ profileId: "p1", seq: -1 }))).toThrow();
  });

  it("rejects a cursor from the itemId-watermark format this release replaced", () => {
    const legacy = Buffer.from(
      JSON.stringify({ profileId: "p1", itemId: "item-42" }),
      "utf8",
    ).toString("base64url");

    expect(() => decodeFeedCursor(legacy)).toThrow();
  });
});
