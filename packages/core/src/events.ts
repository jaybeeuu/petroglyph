import type { ApplicationUserId, NoteId } from "./ids.js";

export interface NoteCreatedEvent {
  type: "note:created";
  noteId: NoteId;
  userId: ApplicationUserId;
  occurredAt: string;
}

export interface NoteUpdatedEvent {
  type: "note:updated";
  noteId: NoteId;
  userId: ApplicationUserId;
  occurredAt: string;
}

export interface NoteDeletedEvent {
  type: "note:deleted";
  noteId: NoteId;
  userId: ApplicationUserId;
  occurredAt: string;
}

export interface NoteVersionCreatedEvent {
  type: "note:version:created";
  noteId: NoteId;
  userId: ApplicationUserId;
  occurredAt: string;
}

export type NoteEvent =
  | NoteCreatedEvent
  | NoteUpdatedEvent
  | NoteDeletedEvent
  | NoteVersionCreatedEvent;

const NOTE_EVENT_TYPES = new Set<string>([
  "note:created",
  "note:updated",
  "note:deleted",
  "note:version:created",
]);

export const isNoteEvent = (v: unknown): v is NoteEvent => {
  if (typeof v !== "object" || v === null || !("type" in v)) {
    return false;
  }
  const { type } = v as { type: unknown };
  return typeof type === "string" && NOTE_EVENT_TYPES.has(type);
};
