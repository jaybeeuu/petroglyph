# 0008. Sync Conflict and Local Deletion Policy

- **Status:** Accepted
- **Date:** 2026-03-09

## Context

The accepted client-sync model defines snapshot bootstrap plus sequence-backed change replay. The platform still needs a concrete policy for how clients handle local divergence in generated files and what they do when notes are deleted upstream or move out of a monitored folder scope.

Client-visible scope changes can occur even when upstream provider identity remains stable, for example when a note moves from one monitored folder to another.

## Decision Drivers

- predictable client behavior
- clear operator experience
- preservation of upstream authority
- low implementation complexity for V1
- avoidance of silent local data loss

## Considered Options

### Option 1: Automatic merge of local and upstream changes

The client tries to merge local edits into generated artifacts automatically.

### Option 2: Generated files are system-managed, with explicit divergence warnings and simple local deletion behavior

The client treats generated outputs as managed artifacts, surfaces divergence to the operator, and applies a simple consistent deletion policy.

### Option 3: Never delete local files automatically

The client leaves all previously materialized files in place and only updates metadata.

## Decision Outcome

Chosen option: **Generated files are system-managed, with explicit divergence warnings and simple local deletion behavior**.

This means:

- generated markdown, images, PDFs, and synced metadata are treated as managed outputs
- clients do not attempt automatic content merges in V1
- if a managed local file has diverged, the client should surface that fact clearly to the operator
- simple operator aids such as timestamps or markdown diffs are acceptable, but are presentation details rather than protocol changes
- when a note is deleted upstream, the client removes or otherwise hides the local managed view according to its configured behavior
- when a note moves out of a monitored-folder scope, the client treats that as deletion from its own visible scope even if provider identity remains stable
- when a note moves into a monitored-folder scope, the client treats that as creation within its own visible scope

## Consequences

### Positive

- client behavior is simpler and more predictable
- upstream remains authoritative
- monitored-folder transitions are easy to model as local scope changes
- operator-facing divergence handling can be improved later without changing core sync contracts

### Negative

- locally edited generated files may be overwritten or removed unless the operator intervenes
- V1 does not provide automatic merge support
- clients need a clear UX for warning about divergence and deletion

### Future enhancement path

As a mitigation for locally modified managed files, a future client enhancement may require explicit operator review before overwriting or deleting a file that appears to have changed since the last client-managed write.
This could be supported with simple review aids such as timestamps or generated diffs.
That enhancement does not change the V1 policy decision in this ADR.

## Validation

- local divergence can be detected and surfaced to the operator
- a note leaving monitored scope is removed or hidden from the local managed view
- a note entering monitored scope appears in the local managed view without changing provider identity rules
- repeated sync application remains idempotent even when notes move across monitored-folder boundaries

## Links

- [RFC 0005](../rfcs/0005-cli-sync-mechanisms-and-local-materialization.md)
- [ADR 0001](0001-client-sync-mechanism-and-sequence-checkpoint-model.md)
- [ADR 0005](0005-onedrive-stable-identity-strategy.md)
