# Petroglyph

Petroglyph is a notes-processing system for turning handwritten PDFs from an e-ink note device into structured, syncable notes.

The initial use case is an Onyx Boox Note Air workflow:

1. handwritten notes are created on the device
2. PDFs are synced to a cloud provider such as OneDrive
3. Petroglyph detects updates and processes those PDFs
4. processed outputs are made available through an authenticated API
5. a cross-platform CLI syncs the resulting notes into a local Obsidian vault

## Why This Exists

The current handwritten-note workflow is useful but fragmented.

- handwritten PDFs are easy to capture on the device
- syncing the raw files to cloud storage is straightforward
- turning those notes into searchable, structured material for Obsidian is still too manual
- local synchronization, retries, and change tracking need a deterministic system rather than ad hoc scripts

Petroglyph exists to provide that system.

## What The System Does

At a high level, the platform is intended to:

- detect note changes from cloud storage providers
- process handwritten-note PDFs into markdown plus extracted artifacts
- store originals and derived outputs in cloud storage
- expose note state and note changes through an authenticated API
- synchronize notes into one or more local Obsidian-compatible directories through a CLI
- leave room for future authenticated site-based note exploration

The first provider is OneDrive, but the architecture is being designed so additional providers can be added later.

## Current Scope

The current repository state is documentation-first. The architecture baseline, ADRs, and implementation planning are being established before package-level implementation begins.

Current assumptions include:

- OneDrive first for provider integration
- AWS for processing, storage, and API hosting
- a cross-platform CLI as the first consumer
- a single-user operational model in V1, with clean boundaries for future multi-user expansion
- an application-owned user/account model rather than treating external identity claims as the entire user model

## Development Approach

The intended development model is hybrid:

- application code should be runnable locally during development
- early phases may still depend on remote services such as AWS, Microsoft Entra, and OneDrive
- local testability and local developer setup are explicit implementation goals, not afterthoughts

## Repository Guide

This repository uses layered documentation.

- `README.md`
  - top-level purpose, scope, and orientation
- `docs/rfcs/`
  - high-level requirements and solution shape
- `docs/adrs/`
  - concrete architectural decisions
- GitHub issues
  - implementation planning, sequencing, and dependency tracking
- future task specs
  - developer-facing breakdown of implementation work inside the repository

Start with these documents:

- [docs/readme.md](docs/readme.md)
- [docs/rfcs/0001-notes-platform-architecture.md](docs/rfcs/0001-notes-platform-architecture.md)
- [docs/target-service-and-package-architecture.md](docs/target-service-and-package-architecture.md)
- [docs/adrs/readme.md](docs/adrs/readme.md)

## Top-Level Requirements

The top-level requirements for the system are:

- ingest note PDFs from a cloud provider after device sync
- detect changes reliably and replay safely
- transform PDFs into useful markdown and related artifacts
- preserve original PDFs alongside derived outputs
- expose synchronized note state through an authenticated API
- support local sync into Obsidian through a CLI
- keep the design extensible for additional providers and future authenticated site access

## What Is Not Here Yet

This repository does not yet contain the full package implementation described in the architecture docs.

The next implementation phase will focus on:

- core contracts and domain types
- application user and provider-connection foundations
- local setup and local test strategy
- ingestion, processing, API, and CLI task-spec breakdown

## License

See [LICENSE](LICENSE).
