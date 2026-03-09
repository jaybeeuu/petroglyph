# 0003. Storage Retention and Read-Model Ownership

- **Status:** Accepted
- **Date:** 2026-03-09

## Context

The accepted RFC set defines S3 as the system of record for note artifacts, a current-state `/notes` view for bootstrap, and a sequence-backed `/notes/changes` feed for incremental synchronization. Implementation now needs a clear ownership model for where binary artifacts live, where current note state and change-log indexing live, and how long change-feed history must be retained for client recovery.

The system also treats deletion as logical state rather than immediate artifact removal, and recreation after deletion as the same logical note with a new version.

## Decision Drivers

- durable artifact storage
- efficient current-state reads for `/notes`
- efficient ordered reads for `/notes/changes`
- safe client recovery from stored sequence checkpoints
- support for logical deletion and undeletion
- low operational complexity for V1

## Considered Options

### Option 1: S3 only for artifacts and read models

Store artifacts, current-state snapshots, and change-feed entries only in S3.

### Option 2: S3 for artifacts plus DynamoDB for current state and change-feed indexing

Store immutable/versioned artifacts in S3 and maintain current note state plus ordered change metadata in DynamoDB.

### Option 3: Relational database plus object storage

Store read models in a relational database and artifacts in object storage.

## Decision Outcome

Chosen option: **S3 for artifacts plus DynamoDB for current state and change-feed indexing**.

This means:

- S3 owns original PDFs, generated markdown, extracted images, note metadata, and version metadata.
- DynamoDB owns the current-state note view that powers `/notes`.
- DynamoDB owns ordered change-feed metadata that powers `/notes/changes`.
- Clients do not treat raw S3 layout as their contract; they consume API read models.
- Deletion is represented logically in DynamoDB read models and metadata while artifacts remain in S3.

### Retention model

For V1:

- note artifacts in S3 are retained by default
- note metadata and version metadata in S3 are retained by default
- current-state note records in DynamoDB are retained while the note exists logically, including deleted/tombstoned state
- change-feed entries in DynamoDB are retained long enough to support normal client recovery from stored `sequence` checkpoints
- if a client checkpoint falls outside the retained change-feed window, the client must recover by re-bootstrapping from `/notes`

The exact retention window for change-feed entries remains a configurable operational parameter, but the architecture assumes change retention is finite rather than infinite.

## Consequences

### Positive

- immutable artifacts stay in a storage system well-suited to binary and document outputs
- `/notes` and `/notes/changes` can be served efficiently without scanning object storage
- logical deletes and undeletion are easy to model in read-state records
- client recovery has a clear model: replay recent changes or fall back to bootstrap

### Negative

- state is split across two storage systems
- processing/publication logic must keep S3 and DynamoDB writes consistent enough for read-model correctness
- a retention policy is still required for change-feed cleanup and replay guarantees

## Validation

- `/notes` can be served from DynamoDB current-state records without reading raw S3 manifests
- `/notes/changes` can be served in global `sequence` order from DynamoDB change entries
- logical deletion preserves existing S3 artifacts while read models mark the note deleted
- clients can recover from recent checkpoints and fall back to `/notes` when their checkpoint is too old

## Links

- [RFC 0003](../rfcs/0003-pdf-processing-artifact-contracts-and-cli-sync.md)
- [RFC 0004](../rfcs/0004-notes-api-and-client-contracts.md)
- [RFC 0005](../rfcs/0005-cli-sync-mechanisms-and-local-materialization.md)
- [Target Service and Package Architecture](../target-service-and-package-architecture.md)
