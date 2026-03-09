# 0004. Manifest Schema and Versioning

- **Status:** Accepted
- **Date:** 2026-03-09

## Context

The accepted RFCs and ADRs define four related data shapes that cross package and service boundaries:

- note-level metadata
- version-level metadata
- `/notes` current-state entries
- `/notes/changes` change-feed entries

These shapes will be produced by processing services, stored across S3 and DynamoDB, and consumed by the API and clients. They need explicit versioning rules so implementation can evolve without silently breaking downstream consumers.

## Decision Drivers

- stable cross-package contracts
- explicit compatibility rules
- safe additive evolution
- low operational complexity for V1
- ability to support bootstrap and change-feed consumers at the same time

## Considered Options

### Option 1: Unversioned JSON documents

Each document shape evolves in place with no explicit version marker.

### Option 2: Explicit schema version per document family with additive-first evolution

Each document family carries its own `schemaVersion`, with additive changes preferred and breaking changes requiring a new version plus compatibility handling.

### Option 3: One global schema version for the entire notes platform

All document families share a single platform-wide version value.

## Decision Outcome

Chosen option: **Explicit schema version per document family with additive-first evolution**.

This means:

- `metadata.json` has an explicit `schemaVersion`
- `version-metadata.json` has an explicit `schemaVersion`
- `/notes` current-state entries have an explicit `schemaVersion`
- `/notes/changes` change entries have an explicit `schemaVersion`
- document families may evolve at different speeds
- additive changes are preferred
- breaking changes require a new version and a compatibility plan in readers/writers

### Required baseline fields

All document families should include:

- `schemaVersion`
- stable identifiers for the entity they describe
- timestamps needed for ordering or auditing

### Compatibility policy

- additive optional fields do not require a version bump if existing readers remain valid
- field removal, required-field addition, or meaning changes do require a version bump
- API and core packages should support the active version and any immediately previous version when needed for migration
- schema evolution must be documented before implementation changes land

## Consequences

### Positive

- each contract is self-describing
- changes can be rolled out incrementally
- different document families are not forced into lockstep
- downstream breakage is easier to detect and reason about

### Negative

- readers and writers must explicitly handle versioning
- some migrations may need temporary dual-read or dual-write behavior
- schema governance adds process overhead

## Validation

- every persisted document family contains `schemaVersion`
- code in shared contract packages validates document family versions explicitly
- additive changes do not break existing readers
- breaking changes require documented compatibility handling

## Links

- [RFC 0003](../rfcs/0003-pdf-processing-artifact-contracts-and-cli-sync.md)
- [RFC 0004](../rfcs/0004-notes-api-and-client-contracts.md)
- [ADR 0001](0001-client-sync-mechanism-and-sequence-checkpoint-model.md)
- [ADR 0003](0003-storage-retention-and-read-model-ownership.md)
- [Target Service and Package Architecture](../target-service-and-package-architecture.md)
