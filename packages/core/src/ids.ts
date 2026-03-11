// Type guards only verify typeof === "string" because branded types are erased at runtime.
// They cannot distinguish between different branded string types; the brand is a compile-time
// constraint only.

export type NoteId = string & { readonly _brand: "NoteId" };
export const asNoteId = (s: string): NoteId => s as NoteId;
export const isNoteId = (v: unknown): v is NoteId => typeof v === "string";

export type VersionId = string & { readonly _brand: "VersionId" };
export const asVersionId = (s: string): VersionId => s as VersionId;
export const isVersionId = (v: unknown): v is VersionId => typeof v === "string";

export type ProviderId = string & { readonly _brand: "ProviderId" };
export const asProviderId = (s: string): ProviderId => s as ProviderId;
export const isProviderId = (v: unknown): v is ProviderId => typeof v === "string";

export type ProviderConnectionId = string & { readonly _brand: "ProviderConnectionId" };
export const asProviderConnectionId = (s: string): ProviderConnectionId => s as ProviderConnectionId;
export const isProviderConnectionId = (v: unknown): v is ProviderConnectionId => typeof v === "string";

export type ApplicationUserId = string & { readonly _brand: "ApplicationUserId" };
export const asApplicationUserId = (s: string): ApplicationUserId => s as ApplicationUserId;
export const isApplicationUserId = (v: unknown): v is ApplicationUserId => typeof v === "string";
