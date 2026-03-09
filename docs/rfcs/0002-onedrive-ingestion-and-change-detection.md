# RFC 0002: OneDrive Ingestion and Change Detection

- **Status:** Accepted
- **Owner:** @jaybeeuu
- **Created:** 2026-03-09
- **Parent RFC:** [0001](0001-notes-platform-architecture.md)

## 1. Summary

Define a reliable ingestion strategy using Microsoft Graph mechanisms to detect PDF updates from the configured OneDrive location and emit idempotent processing events.
The OneDrive implementation is an adapter that plugs into a provider-agnostic ingestion core so adding future providers stays straightforward.
The adapter is also responsible for retrieving source PDFs into a neutral staging area so downstream components never depend on provider-specific APIs.

## 2. Decision Scope

This RFC covers:

- Source path conventions for ingest candidates.
- Change detection model (webhooks + delta reconciliation).
- Event contract for downstream processing.
- Deduplication and replay behavior.
- Provider adapter boundary requirements for future multi-provider support.

## 3. Provider Adapter Architecture

- Define a provider-agnostic ingestion contract in core ingestion.
- Implement OneDrive-specific behavior in a separate adapter component.
- Keep Graph-specific types and semantics inside the OneDrive adapter.
- Emit normalized change events from adapter to core ingestion.

### 3.1 Retrieval and staging responsibility

- Provider adapters own download/retrieval of source documents.
- Retrieved PDFs are written to a standard staging location.
- Downstream processing reads from staging only, never directly from provider APIs.
- Staging entries include metadata needed for traceability and cleanup.

### 3.2 Internal lifecycle event contract

Adapter output to core ingestion uses internal change event types:

- `document.created`
- `document.updated`
- `document.deleted`

These lifecycle events are provider-agnostic and are consumed by later pipeline components.

### 3.3 Normalized change event direction

Normalized events should carry only ingestion-domain fields required by core processing:

- provider name
- provider item identity
- canonical source path
- version marker
- event timestamp
- optional provider metadata map
- staged document reference (for non-delete events)
- change type (`document.created`, `document.updated`, `document.deleted`)

Core ingestion must not depend directly on Graph SDK types.

## 4. Proposed Approach

### 4.1 Source selection

- Configure one or more OneDrive folder roots as ingest scopes.
- Only process files matching PDF criteria.

### 4.2 Detection strategy

- Use Graph change notifications where practical for low-latency signal.
- Reconcile with Graph delta queries as source-of-truth for eventual consistency.
- Treat webhook signal as trigger, delta as correctness mechanism.

### 4.3 Event contract

Processing event must contain:

- Provider (`onedrive`)
- Drive and item identifiers
- Path metadata
- Version markers (eTag/cTag where available)
- Event timestamp
- Correlation/request IDs
- Staging location reference for `document.created` and `document.updated`
- Internal lifecycle change type

### 4.4 Idempotency

- Build idempotency key from `{provider, driveItemId, versionMarker}`.
- Skip duplicate work when idempotency key already completed.
- Allow forced replay using explicit override flags.

## 5. Failure Handling

- Validation failures -> quarantine queue/log bucket with reason.
- Temporary API failures -> retry with bounded exponential backoff.
- Permanent failures -> dead-letter and operator-visible alert.
- Staging write failures -> fail event emission and retry from provider retrieval boundary.
- Staging cleanup failures -> mark for async cleanup and alert when age threshold is exceeded.

## 6. Security Considerations

- Use least-privilege Graph scopes.
- Keep credentials in AWS secret management.
- Validate webhook signatures/challenge flow per provider requirements.

## 7. Alternatives Considered

### 7.1 Local folder watch only

Rejected for V1 because processing is hosted in AWS and cloud-native ingestion is required.

### 7.2 Delta-only polling

Possible fallback, but slower and potentially less efficient at scale.

## 8. Acceptance Criteria

- New/updated PDFs are detected and emitted exactly-once effectively (at-least-once transport with idempotent processing).
- Duplicate webhook events do not create duplicate final artifact versions.
- Reconciliation job can repair missed webhook signals.
- OneDrive adapter can be replaced by a mock second provider adapter without changes to ingestion core contracts.
- Ingestion core compiles and tests without direct imports of Graph-specific SDK types.
- Core processing components can consume staged PDFs and lifecycle events without OneDrive/Graph dependencies.
- `document.deleted` events are emitted without requiring staged document content.

## 9. Open Questions

- Initial webhook lifecycle management and renewal cadence.
- Optimal polling interval for delta reconciliation.
