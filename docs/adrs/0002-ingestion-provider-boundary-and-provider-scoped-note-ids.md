# 0002. Ingestion Provider Boundary and Provider-Scoped Note IDs

- **Status:** Accepted
- **Date:** 2026-03-09

## Context

The platform must support OneDrive first while remaining open to future providers such as Google Drive or Dropbox. The system also needs note identifiers that remain unique and stable enough for downstream processing and clients, without forcing all providers into the same identity strategy.

## Decision Drivers

- future provider extensibility
- isolation of provider-specific SDKs and semantics
- stable ingress-to-processing contracts
- support for provider-specific identity behavior
- minimal downstream coupling to OneDrive or Microsoft Graph

## Considered Options

### Option 1: OneDrive-specific ingestion throughout the pipeline

Use OneDrive types and identifiers directly across ingestion, processing, and API layers.

### Option 2: Provider adapter boundary plus provider-scoped `noteId`

Each provider adapter owns provider-specific logic and chooses a stable identifier strategy within its own address space. Core layers consume normalized contracts only.

### Option 3: Path-only identity for all providers

All providers derive identity only from canonical source paths.

## Decision Outcome

Chosen option: **Provider adapter boundary plus provider-scoped `noteId`**.

This means:

- provider adapters retrieve files and write them to staging
- provider adapters publish normalized lifecycle events from the ingress boundary
- downstream consumers do not depend on provider SDK types
- `noteId` includes a provider-scoped namespace
- each adapter chooses the concrete stable identity strategy inside that namespace

For V1:

- OneDrive launches first
- exact OneDrive stable identity strategy remains a provider-specific follow-up decision
- source moves are treated initially as delete plus create

## Consequences

### Positive

- future providers are easier to add
- ingress contracts stay stable and provider-agnostic for downstream consumers
- providers can choose the most persistent identifier available

### Negative

- exact identity behavior must still be researched per provider
- moves may look like churn in V1 because they are treated as delete/create
- adapter implementations become responsible for more decision logic

## Validation

- processing consumers compile without provider SDK imports
- provider adapter can emit normalized lifecycle events and staging references through an ingress-owned public contract
- a second mock provider can be added without changing the published ingress event contract

## Links

- [RFC 0001](../rfcs/0001-notes-platform-architecture.md)
- [RFC 0002](../rfcs/0002-onedrive-ingestion-and-change-detection.md)
- [Target Service and Package Architecture](../target-service-and-package-architecture.md)
