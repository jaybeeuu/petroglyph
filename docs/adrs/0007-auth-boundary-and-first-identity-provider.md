# 0007. Auth Boundary and First Identity Provider

- **Status:** Accepted
- **Date:** 2026-03-09

## Context

The accepted API RFC requires authenticated access from day one. The notes API will be consumed by multiple client types, beginning with the CLI and potentially followed by a browser-based site. The platform needs a first identity provider and a clear token-validation boundary so API implementation can begin.
The platform should not require end users to be registered as users inside the operator's own Entra tenant.

## Decision Drivers

- authenticated API from day one
- support for both operator-driven and browser-based clients
- low operational complexity for V1
- compatibility with AWS-hosted API infrastructure
- ability to add further providers later without rewriting core API contracts

## Considered Options

### Option 1: Amazon Cognito as the first identity provider

Use Cognito-hosted authentication and AWS-native federation from the start.

### Option 2: Microsoft Entra ID as the first identity provider

Use Microsoft identity directly as the first identity provider via Entra-backed OAuth/OIDC flows, while allowing users to authenticate with their own Microsoft identities rather than requiring tenant-local user registration.

### Option 3: Defer real authentication for V1

Launch with a lightly protected or internal-only API and add full auth later.

## Decision Outcome

Chosen option: **Microsoft identity via Entra-backed OAuth/OIDC as the first identity provider**.

This means:

- Microsoft identity is the first configured identity provider for the notes platform
- the API requires authenticated bearer tokens on protected routes
- token validation happens at the API boundary and is authoritative
- the CLI uses an operator-friendly OAuth/OIDC flow appropriate for a cross-platform native client
- future browser clients use a browser-appropriate OAuth/OIDC flow
- users are expected to authenticate with their own Microsoft identities rather than being provisioned as users in the operator's Entra tenant
- the API contract remains provider-agnostic enough to allow future additional providers behind the same validation boundary if needed

### V1 auth flow assumptions

- CLI: device authorization or another native-client-safe interactive flow
- browser client: authorization code flow with PKCE
- API validation: issuer, audience, expiry, and signature validation are mandatory

This ADR does not choose between API streaming and signed URLs for artifact delivery. That remains a follow-up decision.

## Consequences

### Positive

- secure API from day one
- no Cognito dependency for the initial single-user, single-provider model
- a natural fit for users who already have Microsoft identities
- separate client flows can still share one validated API boundary
- avoids making the operator's Entra tenant the user registry for the platform

### Negative

- Entra-specific app registration and multi-tenant identity configuration are required
- a future move to multi-provider support may require additional auth-layer work
- CLI auth UX must be designed carefully for repeat use and token refresh

## Validation

- a CLI client can obtain an Entra-issued token and call the protected API successfully
- the API rejects missing, malformed, expired, or invalid tokens
- a browser client can authenticate with a browser-safe flow when introduced
- API handlers rely on validated auth context rather than trusting the client

## Links

- [RFC 0004](../rfcs/0004-notes-api-and-client-contracts.md)
- [RFC 0005](../rfcs/0005-cli-sync-mechanisms-and-local-materialization.md)
- [Target Service and Package Architecture](../target-service-and-package-architecture.md)
