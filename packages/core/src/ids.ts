import { z } from "zod";

// Schemas are the source of truth for both the branded type and runtime validation.
// The as* helpers call .parse() on a z.string() schema, which is always safe when the
// argument is already typed as string — Zod will never throw for a valid string input.

export const NoteIdSchema = z.string().brand("NoteId");
export type NoteId = z.infer<typeof NoteIdSchema>;
export const asNoteId = (s: string): NoteId => NoteIdSchema.parse(s);
export const isNoteId = (v: unknown): v is NoteId => NoteIdSchema.safeParse(v).success;

export const VersionIdSchema = z.string().brand("VersionId");
export type VersionId = z.infer<typeof VersionIdSchema>;
export const asVersionId = (s: string): VersionId => VersionIdSchema.parse(s);
export const isVersionId = (v: unknown): v is VersionId => VersionIdSchema.safeParse(v).success;

export const ProviderIdSchema = z.string().brand("ProviderId");
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export const asProviderId = (s: string): ProviderId => ProviderIdSchema.parse(s);
export const isProviderId = (v: unknown): v is ProviderId => ProviderIdSchema.safeParse(v).success;

export const ProviderConnectionIdSchema = z.string().brand("ProviderConnectionId");
export type ProviderConnectionId = z.infer<typeof ProviderConnectionIdSchema>;
export const asProviderConnectionId = (s: string): ProviderConnectionId =>
  ProviderConnectionIdSchema.parse(s);
export const isProviderConnectionId = (v: unknown): v is ProviderConnectionId =>
  ProviderConnectionIdSchema.safeParse(v).success;

export const ApplicationUserIdSchema = z.string().brand("ApplicationUserId");
export type ApplicationUserId = z.infer<typeof ApplicationUserIdSchema>;
export const asApplicationUserId = (s: string): ApplicationUserId =>
  ApplicationUserIdSchema.parse(s);
export const isApplicationUserId = (v: unknown): v is ApplicationUserId =>
  ApplicationUserIdSchema.safeParse(v).success;

export const AuthIdentityIdSchema = z.string().brand("AuthIdentityId");
export type AuthIdentityId = z.infer<typeof AuthIdentityIdSchema>;
export const asAuthIdentityId = (s: string): AuthIdentityId => AuthIdentityIdSchema.parse(s);
export const isAuthIdentityId = (v: unknown): v is AuthIdentityId =>
  AuthIdentityIdSchema.safeParse(v).success;
