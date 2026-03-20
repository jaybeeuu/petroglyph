import { z } from "zod";

const AuthModeSchema = z.enum(["mock", "entra"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

const ApiConfigSchema = z.object({
  authMode: AuthModeSchema,
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  logLevel: z.enum(["error", "warn", "info", "debug"]).default("info"),
  entra: z
    .object({
      tenantId: z.string().min(1),
      clientId: z.string().min(1),
      authority: z.url().optional(),
    })
    .optional(),
});

export type ApiConfig = z.infer<typeof ApiConfigSchema>;

// Loads and validates configuration from environment variables at startup.
// Fails loudly with a descriptive error if required variables are missing or malformed.
export function loadConfig(): ApiConfig {
  const raw = {
    authMode: process.env["AUTH_MODE"] ?? "mock",
    port: process.env["API_PORT"],
    logLevel: process.env["LOG_LEVEL"],
    entra:
      process.env["AUTH_MODE"] === "entra"
        ? {
            tenantId: process.env["ENTRA_TENANT_ID"],
            clientId: process.env["ENTRA_CLIENT_ID"],
            authority: process.env["ENTRA_AUTHORITY"],
          }
        : undefined,
  };

  const result = ApiConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid API configuration:\n${result.error.message}`);
  }

  if (result.data.authMode === "entra" && result.data.entra === undefined) {
    throw new Error(
      "AUTH_MODE=entra requires ENTRA_TENANT_ID and ENTRA_CLIENT_ID to be set.",
    );
  }

  return result.data;
}
