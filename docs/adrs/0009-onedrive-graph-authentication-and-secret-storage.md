# 0009. OneDrive Graph Authentication and Secret Storage

- **Status:** Accepted
- **Date:** 2026-03-09

## Context

The notes ingestion service must authenticate to Microsoft Graph to poll OneDrive changes and retrieve source PDFs. This trust boundary is separate from client-to-notes-API authentication. The platform needs a backend-safe model for acquiring Graph access tokens and storing the required credentials or assertions securely in AWS.
For a future subscription model, the platform should access user-owned OneDrive content with user consent rather than assuming the operator owns the users' OneDrive estates.

## Decision Drivers

- access to user-owned OneDrive content with user consent
- no requirement that users register an app themselves
- no requirement that users exist inside the operator's Entra tenant
- compatibility with AWS-hosted polling workers
- least-privilege access to OneDrive data
- secure secret storage and rotation path

## Considered Options

### Option 1: Delegated user tokens stored and refreshed by the backend

The ingestion service stores delegated refresh tokens and acts on behalf of a user account.

### Option 2: Entra application registration with backend credential flow

The ingestion service authenticates as an Entra application and acquires Graph tokens non-interactively.

### Option 3: Manual export/import of files into AWS without Graph auth

OneDrive is treated as a manual transfer mechanism rather than an authenticated provider integration.

## Decision Outcome

Chosen option: **Delegated user consent with backend-managed refresh and access tokens**.

This means:

- the platform owns a single app registration, but end users authorize that app against their own Microsoft accounts or tenants
- end users do not need to register their own application in OneDrive or Entra
- the ingestion service acquires Graph access on behalf of each connected user using delegated consent
- the service uses the narrowest delegated Graph permissions that can support the required OneDrive read behavior
- app registration secrets are stored in AWS Secrets Manager
- per-user delegated credentials or refresh tokens are stored in a secure application-managed credential store with encryption at rest and tight access control

### Secret storage and runtime behavior

- Secrets Manager is the system of record for confidential application-level Graph auth secrets and related configuration
- per-user delegated connection credentials must not be baked into code or deployment artifacts and must be stored encrypted at rest
- ingestion workers read required secrets and connection credentials at runtime
- rotation should be possible without application redesign
- token acquisition failures must surface clearly in operational telemetry

## Consequences

### Positive

- supports user-owned OneDrive accounts with explicit user consent
- does not require users to exist in the operator's Entra tenant
- does not require each user to register an application themselves
- clean separation between service-to-provider auth and client-to-API auth remains possible

### Negative

- requires secure handling of per-user delegated credentials or refresh tokens
- backend polling is now coupled to user-granted connection state
- Graph permission design must be done carefully to avoid over-broad delegated access
- tenant consent policies in some organizations may still require administrator approval

## Validation

- a connected user can grant delegated consent to the platform-owned app registration
- ingestion worker can refresh Graph access for a connected user without that user re-registering an app
- worker can read the configured OneDrive scope with the minimum approved delegated permissions
- application secrets and per-user connection credentials are not stored in source control or static environment files
- expired, revoked, or invalid delegated credentials cause observable, recoverable failures

## Links

- [RFC 0002](../rfcs/0002-onedrive-ingestion-and-change-detection.md)
- [ADR 0002](0002-ingestion-provider-boundary-and-provider-scoped-note-ids.md)
- [ADR 0007](0007-auth-boundary-and-first-identity-provider.md)
- [Target Service and Package Architecture](../target-service-and-package-architecture.md)
