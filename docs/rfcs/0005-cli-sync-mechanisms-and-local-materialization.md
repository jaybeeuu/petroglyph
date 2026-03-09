# RFC 0005: CLI Sync Mechanisms and Local Materialization

- **Status:** Accepted
- **Owner:** @jaybeeuu
- **Created:** 2026-03-09
- **Parent RFC:** [0001](0001-notes-platform-architecture.md)
- **Related RFCs:** [0003](0003-pdf-processing-artifact-contracts-and-cli-sync.md), [0004](0004-notes-api-and-client-contracts.md)

## 1. Summary

Define the initial CLI consumer for the notes platform, including how it bootstraps from the API, resumes from sequence checkpoints, materializes note artifacts locally, and applies monitored-folder filtering.

## 2. Decision Scope

This RFC covers:

- Local sync behavior for the CLI.
- Checkpoint handling using global `sequence` values.
- Local materialization of note files into an Obsidian-compatible directory structure.
- Monitored-folder filtering and downstream delete handling.
- CLI-facing recovery and operator workflow.

## 3. Proposed Model

### 3.1 Baseline assumptions

- The CLI is the first concrete consumer of the shared notes API.
- The API provides snapshot bootstrap and incremental change-feed access.
- The cloud provider remains the single authoritative source of note events.

### 3.2 Local materialization

- The CLI materializes markdown, images, PDFs, and relevant metadata into a local vault or configured target directory.
- Materialization should be deterministic so repeated sync runs converge on the same local structure.
- Local file layout should remain compatible with Obsidian usage patterns.

### 3.3 Monitored folders

- The CLI supports a configured set of monitored source folders.
- Only notes whose canonical source path matches monitored folders are materialized locally.
- This mechanism is sufficient for domain separation such as `home` and `work` without a more complex policy engine.

### 3.4 Deletions and recreation

- When a note is marked deleted in the change feed, the CLI should reflect the deleted state locally according to its configured behavior.
- Recreation after deletion is treated as the same logical note identity with a new version.

## 4. Operator Experience

- The operator should be able to run an initial bootstrap sync.
- The operator should be able to resume from the last stored checkpoint.
- If the checkpoint becomes invalid or stale, the CLI should fall back to a fresh snapshot/bootstrap workflow.
- The operator should be able to understand what changed locally after a sync run.

## 5. Alternatives Considered

### 5.1 Full manifest download on every run

Rejected as inefficient once the number of notes or versions grows.

### 5.2 Continuous daemon sync only

Rejected for V1; explicit operator-driven sync is simpler and easier to reason about.

## 6. Acceptance Criteria

- The CLI can bootstrap from snapshot and complete an initial local materialization.
- The CLI can resume from a stored `sequence` checkpoint and apply only later changes.
- Local materialization is deterministic across repeated runs.
- Monitored-folder filtering excludes non-matching source paths.
- Deleted notes are reflected locally without requiring artifact removal from upstream storage.

Shared API shape and change-feed semantics are specified separately in RFC 0004.

## 7. Revisit Triggers

Revisit this decision if:

- More than one materially different consumer requires incompatible local sync behavior.
- Background daemon sync becomes a primary use case.
- Local materialization needs to support bidirectional edits rather than generated output only.
