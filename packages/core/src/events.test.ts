import { describe, expect, it } from "vitest";
import {
  NoteCreatedEventSchema,
  NoteDeletedEventSchema,
  NoteEventSchema,
  NoteUpdatedEventSchema,
  NoteVersionCreatedEventSchema,
  isNoteEvent,
} from "./events.js";

const validBase = {
  noteId: "note-1",
  userId: "user-1",
  occurredAt: "2024-01-01T00:00:00.000Z",
};

describe("event schemas", () => {
  it.each([
    { schemaName: "NoteCreatedEventSchema", schema: NoteCreatedEventSchema, type: "note:created" },
    { schemaName: "NoteUpdatedEventSchema", schema: NoteUpdatedEventSchema, type: "note:updated" },
    { schemaName: "NoteDeletedEventSchema", schema: NoteDeletedEventSchema, type: "note:deleted" },
    {
      schemaName: "NoteVersionCreatedEventSchema",
      schema: NoteVersionCreatedEventSchema,
      type: "note:version:created",
    },
  ])("$schemaName parses a valid event and brands the IDs", ({ schema, type }) => {
    const result = schema.safeParse({ ...validBase, type });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe(type);
      expect(result.data.noteId).toBe(validBase.noteId);
      expect(result.data.userId).toBe(validBase.userId);
    }
  });

  it.each([
    { schemaName: "NoteCreatedEventSchema", schema: NoteCreatedEventSchema, type: "note:created" },
    { schemaName: "NoteUpdatedEventSchema", schema: NoteUpdatedEventSchema, type: "note:updated" },
    { schemaName: "NoteDeletedEventSchema", schema: NoteDeletedEventSchema, type: "note:deleted" },
    {
      schemaName: "NoteVersionCreatedEventSchema",
      schema: NoteVersionCreatedEventSchema,
      type: "note:version:created",
    },
  ])("$schemaName rejects an event with a missing field", ({ schema, type }) => {
    const result = schema.safeParse({ type, noteId: "note-1" });
    expect(result.success).toBe(false);
  });
});

describe("NoteEventSchema", () => {
  it.each([
    { type: "note:created" },
    { type: "note:updated" },
    { type: "note:deleted" },
    { type: "note:version:created" },
  ])("parses a valid $type event", ({ type }) => {
    const result = NoteEventSchema.safeParse({ ...validBase, type });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown event type", () => {
    const result = NoteEventSchema.safeParse({ ...validBase, type: "note:unknown" });
    expect(result.success).toBe(false);
  });
});

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

  it("returns false when required fields are missing", () => {
    expect(isNoteEvent({ type: "note:created" })).toBe(false);
  });
});
