# 0005. OneDrive Stable Identity Strategy

- **Status:** Accepted
- **Date:** 2026-03-09

## Context

ADR 0002 established that note identity is provider-scoped and that each provider adapter chooses the most stable identifier strategy within its own address space. The OneDrive adapter is the first concrete implementation and needs a stable identity rule so notes can survive renames and moves where possible.

## Decision Drivers

- persistence across rename and move within OneDrive
- low ambiguity for delete/recreate behavior
- compatibility with provider-scoped `noteId`
- minimal dependence on mutable paths
- practical V1 implementation simplicity

## Considered Options

### Option 1: Canonical path only

Derive identity from the path under the monitored source root.

### Option 2: OneDrive `driveId + itemId`

Use OneDrive-native item identity scoped by drive.

### Option 3: Content hash identity

Treat content equality as identity.

## Decision Outcome

Chosen option: **OneDrive `driveId + itemId` as the stable provider-local identity basis**.

This means:

- OneDrive note identity uses provider namespace plus `driveId` and `itemId`
- path is treated as metadata, not primary identity
- rename or move within the same OneDrive drive should preserve note identity
- canonical path updates are recorded in note metadata when the source location changes

### V1 boundary conditions

- moves across drive boundaries are treated as delete plus create
- if OneDrive emits a new `itemId`, the system treats that as a new source item
- delete followed by recreation of the same logical file is treated according to upstream identity evidence; if `itemId` changes, V1 treats it as a new source item within the provider address space

In this ADR, **across drive boundaries** means the item moves from one OneDrive `driveId` to another.
Examples may include movement between materially different OneDrive drives such as separate document libraries or other provider-visible drive containers.

### Client-visible implications

Provider identity and client-visible presence are not always the same thing.

- If a note moves within the same `driveId`, provider-local identity should remain stable.
- If that move crosses a monitored-folder boundary for a client, the client may still need to treat the result as a logical delete from one local view and a logical create in another local view.
- For example, if a client watches only folder `a` and a note moves from folder `a` to folder `b`, the note is effectively deleted from that client's visible scope even if the provider-local `noteId` remains the same.

Clients therefore need to apply monitored-folder filtering after identity resolution and should be careful not to confuse scope changes with upstream identity changes.

## Consequences

### Positive

- identity is stable across common rename/move operations
- path remains available for monitored-folder filtering without defining identity
- provider adapter behavior is aligned with provider-native semantics

### Negative

- cross-drive moves still look like churn in V1
- implementation depends on the stability guarantees of OneDrive item identity
- recreation semantics may differ depending on whether OneDrive preserves `itemId`
- client-visible folder-boundary moves can still behave like delete/create events within a filtered local view

## Validation

- rename within a drive preserves `noteId`
- move within a drive preserves `noteId`
- canonical path updates without changing logical identity
- cross-drive move or new `itemId` is handled as delete plus create
- monitored-folder filtering can make an in-drive move appear as a delete/create transition for a specific client scope without changing the underlying provider-local `noteId`

## Links

- [RFC 0002](../rfcs/0002-onedrive-ingestion-and-change-detection.md)
- [ADR 0002](0002-ingestion-provider-boundary-and-provider-scoped-note-ids.md)
- [Target Service and Package Architecture](../target-service-and-package-architecture.md)
