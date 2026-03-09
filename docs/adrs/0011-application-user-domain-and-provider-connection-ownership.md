# 0011. Application User Domain and Provider Connection Ownership

- **Status:** Accepted
- **Date:** 2026-03-09

## Context

The accepted auth ADR establishes token validation and Microsoft identity as the first external identity provider. The accepted provider-auth ADR establishes delegated user consent and per-user provider credentials for OneDrive access. What is still missing is the application-owned domain model that sits between those two boundaries.

The platform now needs a clear decision for what an application user is, how external identities are linked to that user, how provider connections are owned, and what internal state should be attributable to that application account from the start.

V1 remains operationally single-user, but the design should avoid hard-coding a singleton assumption so future multi-user and multi-provider support can be added without changing the core ownership model.

## Decision Drivers

- explicit separation between external identity and application-owned user state
- admin-controlled access for V1
- clear ownership of provider connections and delegated credentials
- future expansion to multiple users and multiple provider connections
- consistent authorization decisions across API, ingestion, and future site clients
- minimal V1 operational complexity without painting the model into a corner

## Considered Options

### Option 1: Treat validated identity-provider claims as the user model

A valid Entra identity is treated as the application user directly, with little or no application-owned user state.

### Option 2: Introduce an application-owned user/account model with linked auth identities and owned provider connections

The application stores its own user records, links validated external identities to those records, and treats provider connections as resources owned by an application user.

### Option 3: Keep V1 as an implicit singleton with no real user domain yet

Assume one operator and defer explicit user/account modeling until a future multi-user phase.

## Decision Outcome

Chosen option: **Introduce an application-owned user/account model with linked auth identities and owned provider connections**.

This means:

- an **application user/account** is a first-class internal domain concept
- an **external auth identity** is not itself the application user; it is linked to an application user after successful validation
- a **provider connection** is a first-class resource owned by an application user
- provider credentials, refresh state, polling checkpoints, and related operational connection state are owned in the context of that provider connection
- notes, ingestion state, and authorization decisions should be attributable to an application user from the start
- where practical, note and change-publication records should also carry provider-connection attribution so future filtering and auditing do not require repartitioning the model

### V1 operating rules

- accounts are **admin-created only** in V1
- login succeeds only when the validated external identity is linked to a known application account
- V1 is operationally single-user, but the model must still support more than one user record without redesign
- V1 allows one provider connection per user, but the model must use stable connection identifiers and ownership references so multiple connections can be added later
- authorization decisions for protected API access resolve from application-account state, not raw token claims alone

### Domain boundary implications

- external identity providers remain responsible for authentication
- the application user domain remains responsible for account lifecycle, linkage, enablement, and authorization context
- provider adapters and polling jobs execute in the context of a provider connection owned by an application user
- the future authenticated site and the CLI should both consume the same application-account authorization model rather than inventing separate user concepts

This ADR does not choose the exact persistence technology for user accounts, auth-identity linkage records, or provider-connection metadata.
It also does not define billing, team/workspace collaboration, or a full RBAC model beyond what is required for admin-created account control.

## Consequences

### Positive

- the platform gains a clear internal user boundary instead of treating token claims as the whole model
- API authorization can depend on application-owned state such as account status and linked connections
- provider credentials and polling state have an explicit ownership model
- future multi-user and multi-provider expansion can build on the same contracts
- CLI and future site clients can share the same user/account concepts

### Negative

- V1 now requires explicit account provisioning and identity-link management
- implementation must persist and resolve more internal state than a token-only model
- some future follow-up decisions may still be required around credential retention, disconnection, and account deletion lifecycle

## Validation

- the system can distinguish external identity, application account, and provider connection as separate concepts
- a validated external identity alone is insufficient unless it is linked to a known application account
- a provider connection can be attributed to exactly one application account in V1
- API authorization can deny access for disabled or unknown application accounts even when token validation succeeds
- ingestion and provider-auth flows can identify which application account owns the delegated provider connection being used

## Links

- [RFC 0004](../rfcs/0004-notes-api-and-client-contracts.md)
- [ADR 0007](0007-auth-boundary-and-first-identity-provider.md)
- [ADR 0009](0009-onedrive-graph-authentication-and-secret-storage.md)
- [Target Service and Package Architecture](../target-service-and-package-architecture.md)
