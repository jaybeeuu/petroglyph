import { describe, expect, it } from "vitest";
import { isNoteEvent } from "./events.js";
import { asApplicationUserId, asNoteId } from "./ids.js";

describe("isNoteEvent", () => {
  const baseEvent = {
    noteId: asNoteId("note-1"),
    userId: asApplicationUserId("user-1"),
    occurredAt: "2024-01-01T00:00:00.000Z",
  };

  it("returns true for a note:created event", () => {
    expect(isNoteEvent({ ...baseEvent, type: "note:created" })).toBe(true);
  });

  it("returns true for a note:updated event", () => {
    expect(isNoteEvent({ ...baseEvent, type: "note:updated" })).toBe(true);
  });

  it("returns true for a note:deleted event", () => {
    expect(isNoteEvent({ ...baseEvent, type: "note:deleted" })).toBe(true);
  });

  it("returns true for a note:version:created event", () => {
    expect(isNoteEvent({ ...baseEvent, type: "note:version:created" })).toBe(true);
  });

  it("returns false for an unknown event type", () => {
    expect(isNoteEvent({ ...baseEvent, type: "note:unknown" })).toBe(false);
  });

  it("returns false for a non-object", () => {
    expect(isNoteEvent("note:created")).toBe(false);
    expect(isNoteEvent(42)).toBe(false);
    expect(isNoteEvent(null)).toBe(false);
  });

  it("returns false when type is missing", () => {
    expect(isNoteEvent({ noteId: "note-1" })).toBe(false);
  });

  it("returns false when type is not a string", () => {
    expect(isNoteEvent({ ...baseEvent, type: 123 })).toBe(false);
  });
});
