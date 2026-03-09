# 0001. Client Sync Mechanism and Sequence Checkpoint Model

- **Status:** Accepted
- **Date:** 2026-03-09

## Context

The accepted RFC set defines a snapshot plus incremental change-feed model for client synchronization. The system needs a simple, durable way for clients to bootstrap, resume after failure, and recover without replaying the entire corpus on every run.

## Decision Drivers

- simple recovery after interruption
- deterministic and idempotent client behavior
- low bandwidth use after initial bootstrap
- easy reasoning about ordering and replay
- compatibility with multiple future clients

## Considered Options

### Option 1: Full snapshot on every sync

Clients download the full current state every time.

### Option 2: Snapshot bootstrap plus global sequence-backed change feed

Clients bootstrap from `/notes` and then resume from `/notes/changes` using the last applied global `sequence`.

### Option 3: Opaque cursor-only model

Clients rely on opaque continuation tokens with no stable visible checkpoint.

## Decision Outcome

Chosen option: **Snapshot bootstrap plus global sequence-backed change feed**.

Clients:

- bootstrap from `/notes`
- store the last successfully applied global `sequence`
- request `/notes/changes?afterSequence=<lastApplied>`
- apply changes idempotently
- advance their checkpoint only after successful batch completion

The default change-feed response batch size is 100 entries unless overridden within safe service limits.

## Consequences

### Positive

- straightforward failure recovery
- easy client implementation
- globally ordered replay model
- efficient steady-state synchronization

### Negative

- requires a single authoritative sequence allocation path
- clients must implement atomic checkpoint persistence
- large bootstrap syncs may still be expensive for first run

## Validation

- client can bootstrap from `/notes`
- client can resume from stored `sequence`
- reprocessing the same batch does not corrupt local state
- partial failure does not advance checkpoint prematurely

## Links

- [RFC 0004](../rfcs/0004-notes-api-and-client-contracts.md)
- [RFC 0005](../rfcs/0005-cli-sync-mechanisms-and-local-materialization.md)
- [Target Service and Package Architecture](../target-service-and-package-architecture.md)
