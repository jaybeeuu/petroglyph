# Notes Platform Design Docs

This folder holds architecture and planning documents for the notes ingestion, processing, and sync platform.

## Status Model

- `Draft`: initial proposal under active authoring.
- `Review`: ready for review and comments.
- `Accepted`: approved and ready for implementation.
- `Superseded`: replaced by a newer RFC or ADR.

## RFCs

- [0001 Notes Platform Architecture](rfcs/0001-notes-platform-architecture.md) — `Accepted`
- [0002 OneDrive Ingestion and Change Detection](rfcs/0002-onedrive-ingestion-and-change-detection.md) — `Accepted`
- [0003 PDF Processing, Artifact Contracts, and CLI Sync](rfcs/0003-pdf-processing-artifact-contracts-and-cli-sync.md) — `Accepted`
- [0004 Notes API and Client Contracts](rfcs/0004-notes-api-and-client-contracts.md) — `Accepted`
- [0005 CLI Sync Mechanisms and Local Materialization](rfcs/0005-cli-sync-mechanisms-and-local-materialization.md) — `Accepted`

## Architecture Notes

- [Target Service and Package Architecture](target-service-and-package-architecture.md)

## Related

- [ADR index](adrs/readme.md)

## Scope Notes

Current baseline assumptions captured by these RFCs:

- OneDrive Graph API drives ingestion through delta and webhook patterns.
- Processing runs in AWS.
- S3 is source of truth for output artifacts.
- V1 output includes markdown text, extracted images, and original PDFs.
- Laptop sync is a manual CLI pull model.
- CLI synchronization is expected to use a snapshot + sequential change-feed model rather than repeatedly downloading a full unified manifest.

## Current Phase

The RFC baseline is accepted.
Current work is focused on converting the accepted RFC set into target service architecture notes and implementation-shaping ADRs.
