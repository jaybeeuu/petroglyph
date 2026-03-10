# RFC 0003: PDF Processing, Artifact Contracts, and CLI Sync

- **Status:** Accepted
- **Owner:** @jaybeeuu
- **Created:** 2026-03-09
- **Parent RFC:** [0001](0001-notes-platform-architecture.md)

## 1. Summary

Define V1 output contracts and synchronization semantics from AWS processing into local Obsidian vaults.

## 2. Decision Scope

This RFC covers:

- Processing outputs and storage layout.
- processing-owned publication records and storage layout.
- client pull model and local checkpoint/sequence behavior.
- Delete handling for downstream consumers.
- Configurable monitored-folder pull behavior for split note domains (for example home vs work).

## 3. V1 Output Contract

For each processed PDF, V1 must produce:

1. Markdown text output.
2. Extracted images (linked/embedded from markdown).
3. Original PDF copy preserved.
4. Immutable metadata JSON records split between note-level shared metadata and version-level metadata.

## 4. Storage Model

- S3 is source of truth.
- Artifacts stored under deterministic prefixes by logical note ID and version.
- Storage supports both a current-state snapshot view and a sequential change log for downstream API publication.
- Each note includes shared metadata for stable source context, while each version includes immutable version-specific metadata.

### 4.1 Suggested prefix structure

```text
s3://notes-bucket/
  notes/{noteId}/
    metadata.json
    versions/{versionId}/source.pdf
    versions/{versionId}/content.md
    versions/{versionId}/version-metadata.json
    versions/{versionId}/images/*
  snapshots/current.json
  changes/{sequence}.json
```

### 4.2 Metadata artifact

The top-level `notes/{noteId}/metadata.json` stores shared metadata that is expected to remain stable across versions unless the note itself is materially reclassified.

It should contain, at minimum:

- note ID
- source provider
- original source location/path
- provider item identifiers
- tags or classifications derived from the source system
- canonical source folder/path for monitored-folder matching

Shared note metadata should be updated only when the note-level identity or classification genuinely changes.

Each `versions/{versionId}/version-metadata.json` file is immutable once written for a given `versionId`.

It should contain, at minimum:

- note ID
- version ID
- source timestamps and version markers
- artifact paths for the generated outputs
- checksum references
- ingestion and processing timestamps

If version-specific metadata changes in a meaningful way, a new `versionId` should be created rather than mutating an existing version metadata file.

## 5. Snapshot and Change-Feed Direction

The processing domain should publish two related but distinct read models for downstream consumption:

- a snapshot/current-state view for bootstrap and recovery
- a sequential change feed for incremental synchronization

The single authoritative source of change events is the cloud provider, normalized through the ingestion pipeline.
This RFC does not define multi-source merge behavior.

### 5.1 Snapshot view

Snapshot publication records should include:

- note ID
- source metadata
- current version ID
- artifact paths/checksums
- note metadata path/checksum
- version metadata path/checksum
- updated timestamp
- deletion/archival marker

Deletion is represented logically in the snapshot and metadata rather than by immediate artifact removal.

### 5.2 Change-feed view

Each published change record should include:

- monotonically increasing global `sequence`
- change type (`document.created`, `document.updated`, `document.deleted`)
- note ID
- version ID when relevant
- changed timestamp
- enough artifact and metadata references for consumers to fetch the new state

The baseline V1 cursor model is the last successfully applied `sequence` value.
Opaque or encoded tokens may be introduced later, but should resolve to a durable sequence position internally.

Processing-owned publication schemas must be versioned and backward-compatible where practical.
The API may project these records into client-facing response models, but the API owns the external REST contract exposed to clients.

## 6. Client Sync Model (V1)

- Consumers bootstrap from a remote snapshot when first configured or when recovery is required.
- Consumers store a local checkpoint representing the last successfully applied `sequence`.
- Normal sync reads the remote change feed for entries with `sequence` greater than the stored checkpoint.
- Consumers apply additions, updates, and deletions according to their local policy.
- Consumers write the new checkpoint only after successful batch completion.

## 7. Monitored Folders and Pull Scope (Phase 2)

- Source folders remain visible in the upstream system.
- Consumers can be configured with a set of monitored folders that define what is eligible to be pulled locally.
- Folder membership is derived from canonical source paths recorded in the manifest.
- This provides a simple way to separate domains such as `home` and `work` without introducing a broader policy engine.
- Pull-scope evaluation is deterministic and logged with redacted detail.

## 8. Deletion Handling

When remote item state indicates deletion or archival:

- mark the note as deleted in the snapshot/read model and note metadata.
- preserve existing stored artifacts in place for auditability, recovery, and potential undeletion.

If a previously deleted source item is later recreated or restored, V1 treats it as the same logical note identity.
Creation after deletion clears the deleted state and produces a new version rather than creating a brand new note identity.

## 9. Alternatives Considered

### 9.1 Direct-write to vault from cloud

Rejected for V1 due to operational complexity and reduced local control.

### 9.2 Continuous daemon sync only

Rejected for V1; manual pull is safer and easier to reason about.

## 10. Acceptance Criteria

- Pull command converges local vault to remote manifest deterministically.
- Initial pull can bootstrap from a snapshot view.
- Subsequent pulls can resume from a stored `sequence` checkpoint and apply only later changes.
- Re-running pull without upstream changes is no-op.
- Corrupted/incomplete downloads are detected and retried.
- Monitored-folder configuration can exclude selected source folders from pull results.
- Pull-scope errors prevent pull execution and produce operator-readable diagnostics.
- Each note includes shared metadata for stable source context.
- Each processed version includes an immutable `version-metadata.json` with version markers, timestamps, artifact references, and checksums.
- Deletion marks note state logically without removing stored artifacts.
- Recreation after deletion restores the note as the same logical note ID and produces a new version.

## 11. Open Questions

- Whether OCR confidence metadata should be exposed in markdown frontmatter in V1 or deferred.
