import { z } from "zod";
import { ApplicationUserIdSchema, NoteIdSchema } from "./ids.js";

const noteEventBaseSchema = z.object({
  noteId: NoteIdSchema,
  userId: ApplicationUserIdSchema,
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
