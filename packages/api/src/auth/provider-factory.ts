import { MockAuthProvider } from "./mock-provider.js";
import { EntraAuthProvider } from "./entra-provider.js";
import type { AuthProvider } from "./provider.js";
import type { ApiConfig } from "../config.js";

// Returns the correct AuthProvider based on the resolved API configuration.
// Using AUTH_MODE=mock selects MockAuthProvider; AUTH_MODE=entra selects EntraAuthProvider.
export function createAuthProvider(config: ApiConfig): AuthProvider {
  if (config.authMode === "entra") {
    if (!config.entra) {
      throw new Error("Entra config is required when authMode is 'entra'.");
    }
    const opts: { tenantId: string; clientId: string; authority?: string } = {
      tenantId: config.entra.tenantId,
      clientId: config.entra.clientId,
    };
    if (config.entra.authority !== undefined) {
      opts.authority = config.entra.authority;
    }
    return new EntraAuthProvider(opts);
  }
  return new MockAuthProvider();
}
