import { z } from "zod";
import {
  ApplicationUserIdSchema,
  AuthIdentityIdSchema,
  ProviderConnectionIdSchema,
  ProviderIdSchema,
} from "@petroglyph/core";

export const AccountStatusSchema = z.enum(["active", "disabled"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const ApplicationUserSchema = z.object({
  id: ApplicationUserIdSchema,
  status: AccountStatusSchema,
  displayName: z.string(),
  createdAt: z.iso.datetime(),
});
export type ApplicationUser = z.infer<typeof ApplicationUserSchema>;

export const AuthIdentitySchema = z.object({
  id: AuthIdentityIdSchema,
  userId: ApplicationUserIdSchema,
  provider: z.string(),
  externalId: z.string(),
  externalEmail: z.string().optional(),
  createdAt: z.iso.datetime(),
});
export type AuthIdentity = z.infer<typeof AuthIdentitySchema>;

export const ConnectionStatusSchema = z.enum(["active", "disconnected", "error"]);
export type ConnectionStatus = z.infer<typeof ConnectionStatusSchema>;

export const ProviderConnectionSchema = z.object({
  id: ProviderConnectionIdSchema,
  userId: ApplicationUserIdSchema,
  providerId: ProviderIdSchema,
  status: ConnectionStatusSchema,
  createdAt: z.iso.datetime(),
});
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;
