import { z } from "zod";
import { ApplicationUserIdSchema, AuthIdentityIdSchema } from "@petroglyph/core";

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
