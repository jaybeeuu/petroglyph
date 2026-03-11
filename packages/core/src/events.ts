import { z } from "zod";
import { asApplicationUserId, asNoteId } from "./ids.js";

const noteIdSchema = z.string().transform(asNoteId);
const applicationUserIdSchema = z.string().transform(asApplicationUserId);

const noteEventBaseSchema = z.object({
  noteId: noteIdSchema,
  userId: applicationUserIdSchema,
  occurredAt: z.string(),
});

export const NoteCreatedEventSchema = noteEventBaseSchema.extend({
  type: z.literal("note:created"),
});
export type NoteCreatedEvent = z.infer<typeof NoteCreatedEventSchema>;

export const NoteUpdatedEventSchema = noteEventBaseSchema.extend({
  type: z.literal("note:updated"),
});
export type NoteUpdatedEvent = z.infer<typeof NoteUpdatedEventSchema>;

export const NoteDeletedEventSchema = noteEventBaseSchema.extend({
  type: z.literal("note:deleted"),
});
export type NoteDeletedEvent = z.infer<typeof NoteDeletedEventSchema>;

export const NoteVersionCreatedEventSchema = noteEventBaseSchema.extend({
  type: z.literal("note:version:created"),
});
export type NoteVersionCreatedEvent = z.infer<typeof NoteVersionCreatedEventSchema>;

export const NoteEventSchema = z.discriminatedUnion("type", [
  NoteCreatedEventSchema,
  NoteUpdatedEventSchema,
  NoteDeletedEventSchema,
  NoteVersionCreatedEventSchema,
]);
export type NoteEvent = z.infer<typeof NoteEventSchema>;

export const isNoteEvent = (v: unknown): v is NoteEvent => NoteEventSchema.safeParse(v).success;
