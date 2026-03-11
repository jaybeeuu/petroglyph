# 0013. Note Event Contract Ownership

- **Status:** Accepted
- **Date:** 2026-03-11

## Context

The initial `packages/core` implementation included Zod schemas for note lifecycle events
(`NoteCreatedEventSchema`, `NoteUpdatedEventSchema`, `NoteDeletedEventSchema`,
`NoteVersionCreatedEventSchema`, `NoteEventSchema`). During review it became clear that these
schemas describe behavior specific to the note ingress service — they define what that service
emits, and no other bounded context should emit them.

Placing ingress-owned event contracts in the shared kernel creates the same boundary violation as
placing the application-user domain types there. The shared kernel should contain only primitives
that are genuinely cross-cutting and belong to no single bounded context.

Note ID types (`NoteId`, `VersionId`, etc.) are different: they are opaque identity references
that survive transport across every context boundary — ingress emits them, processing stores them,
the API exposes them. Any consumer of the ingress event contract must also import from
`@petroglyph/core` for the ID types it references.

## Decision Drivers

- keep `packages/core` narrow and stable with no service-owned contracts
- event contracts should live with the service that owns and emits them
- consumers of the event contract take a dependency on the ingress package rather than on core
- align with the principle already established when user/account types were removed from core
- preserve the Zod-based design so the event catalog, EventBridge, and schema tooling story is
  not lost

## Considered Options

### Option 1: Keep note event schemas in `packages/core`

All note lifecycle event schemas stay in the shared kernel because they depend on `NoteIdSchema`
and `ApplicationUserIdSchema` which are already there.

### Option 2: Move note event schemas to the ingress package when it is created

Leave them in core for now and move them later when the ingress package exists.

### Option 3: Remove note event schemas from `packages/core` now; define them in the ingress package

Remove the event schemas from core immediately. The ingress service will define and publish its
own event contract as part of its implementation. Consumers take a dependency on the ingress
package to consume those schemas.

## Decision Outcome

Chosen option: **Remove note event schemas from `packages/core` now; define them in the ingress
package**.

This means:

- `packages/core` no longer contains any note lifecycle event schemas
- the ingress bounded context (see issue #7) defines and owns the note event contract
- consumers that need to parse or type-check note events take a dependency on the ingress package
- ID types (`NoteId`, `VersionId`, `ApplicationUserId`, etc.) remain in `packages/core` because
  they are opaque references used across every boundary

The prototype schema design captured for reference when implementing the ingress contract:

```ts
import { z } from "zod";
import { ApplicationUserIdSchema, NoteIdSchema } from "@petroglyph/core";

const noteEventBaseSchema = z.object({
  noteId: NoteIdSchema,
  userId: ApplicationUserIdSchema,
  occurredAt: z.string(),
});

export const NoteCreatedEventSchema = noteEventBaseSchema.extend({
  type: z.literal("note:created"),
});
export const NoteUpdatedEventSchema = noteEventBaseSchema.extend({
  type: z.literal("note:updated"),
});
export const NoteDeletedEventSchema = noteEventBaseSchema.extend({
  type: z.literal("note:deleted"),
});
export const NoteVersionCreatedEventSchema = noteEventBaseSchema.extend({
  type: z.literal("note:version:created"),
});
export const NoteEventSchema = z.discriminatedUnion("type", [
  NoteCreatedEventSchema,
  NoteUpdatedEventSchema,
  NoteDeletedEventSchema,
  NoteVersionCreatedEventSchema,
]);
export type NoteEvent = z.infer<typeof NoteEventSchema>;
```

Key design decisions for the ingress implementation to preserve:

- each event carries `noteId`, `userId`, and `occurredAt` on every record
- types are derived via `z.infer` from Zod schemas — schemas are the single source of truth
- the `type` discriminant maps to an EventBridge `detail-type` if/when that migration happens
- `NoteIdSchema` and `ApplicationUserIdSchema` are imported from `@petroglyph/core`

## Consequences

### Positive

- `packages/core` stays free of service-owned contracts
- the ingress package owns and publishes its own contract; consumers import from there
- boundary violations are not reintroduced as more bounded contexts are added
- the Zod schema design is preserved for the ingress implementation to adopt

### Negative

- consumers of note events must depend on the ingress package rather than the shared kernel
- the ingress package's public contract becomes part of its API surface and must be versioned
  with care

## Validation

- `packages/core` contains no imports from ingress or other bounded-context packages
- `packages/core` exports no event schemas or event types
- the ingress package (once implemented) exports its own note event schemas and guards
- downstream consumers compile without importing event types from `@petroglyph/core`

## Links

- [ADR 0002 Ingestion Provider Boundary and Provider-Scoped Note IDs](0002-ingestion-provider-boundary-and-provider-scoped-note-ids.md)
- [ADR 0011 Application User Domain and Provider Connection Ownership](0011-application-user-domain-and-provider-connection-ownership.md)
- [Issue #7 OneDrive Delta Polling Worker and Ingestion](https://github.com/jaybeeuu/petroglyph/issues/7)
- [Issue #2 Shared Kernel Primitives and Boundary Rules](https://github.com/jaybeeuu/petroglyph/issues/2)
