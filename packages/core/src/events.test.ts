import { describe, expect, it } from "vitest";
import { isNoteEvent } from "./events.js";

const validBase = {
  noteId: "note-1",
  userId: "user-1",
  occurredAt: "2024-01-01T00:00:00.000Z",
};

describe("isNoteEvent", () => {
  it.each([
    { type: "note:created" },
    { type: "note:updated" },
    { type: "note:deleted" },
    { type: "note:version:created" },
  ])("returns true for a valid $type event", ({ type }) => {
    expect(isNoteEvent({ ...validBase, type })).toBe(true);
  });

  it("returns false for an unknown event type", () => {
    expect(isNoteEvent({ ...validBase, type: "note:unknown" })).toBe(false);
  });

  it.each([
    { label: "a string", value: "note:created" },
    { label: "a number", value: 42 },
    { label: "null", value: null },
  ])("returns false for $label", ({ value }) => {
    expect(isNoteEvent(value)).toBe(false);
  });
});
