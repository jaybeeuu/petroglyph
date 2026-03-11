import type { ApplicationUserId, ProviderConnectionId, ProviderId } from "./ids.js";

export interface ApplicationUser {
  id: ApplicationUserId;
  displayName: string;
  email: string;
  createdAt: string;
}

export interface ExternalAuthIdentity {
  provider: ProviderId;
  externalId: string;
  email: string;
}

export interface ProviderConnection {
  id: ProviderConnectionId;
  userId: ApplicationUserId;
  provider: ProviderId;
  externalId: string;
  connectedAt: string;
}
