# RFC 0001: Notes Platform Architecture

- **Status:** Accepted
- **Owner:** @jaybeeuu
- **Created:** 2026-03-09
- **Related RFCs:** [0002](0002-onedrive-ingestion-and-change-detection.md), [0003](0003-pdf-processing-artifact-contracts-and-cli-sync.md), [0004](0004-notes-api-and-client-contracts.md), [0005](0005-cli-sync-mechanisms-and-local-materialization.md)

## 1. Summary

Define an end-to-end notes platform that ingests handwritten-note PDFs from OneDrive updates, processes them in AWS into markdown plus extracted images, stores original and derived artifacts in S3, and synchronizes to local Obsidian vaults through a cross-platform CLI. Future site exploration pages remain possible, but are not part of the current RFC set.

## 2. Problem

Current note flow is manual and fragmented:

- Boox device produces useful handwritten PDFs.
- PDFs can sync to cloud storage.
- Transforming these PDFs into searchable/editable markdown for Obsidian is manual.
- There is no deterministic pipeline contract for updates, retries, or local synchronization.

## 3. Goals

- Detect note changes from OneDrive reliably.
- Keep ingestion provider-agnostic so future providers (for example Google Drive and Dropbox) can be added with minimal core changes.
- Keep bounded contexts explicit so ingress, processing, API, and CLI can evolve behind well-defined contracts.
- Process PDFs in AWS and generate stable artifact outputs.
- Keep S3 as system-of-record for original and processed artifacts.
- Provide a cross-platform CLI to sync artifacts into one or more Obsidian vaults.
- Preserve deterministic IDs and path mapping for repeatability.
- Prepare private site-read capabilities without coupling them to V1 delivery.

## 4. Non-goals

- Full multi-user collaboration in V1.
- Real-time bi-directional editing sync in V1.
- Diagram semantic interpretation beyond image extraction in V1.
- Mandatory Cognito adoption.

## 5. Users and Primary Flows

### 5.1 Primary user

Single operator (you), managing personal notes and vaults.

### 5.2 Core flow

1. Boox updates PDF in OneDrive.
2. Provider adapter detects change, retrieves PDF to staging, and emits internal lifecycle event (`document.created`, `document.updated`, or `document.deleted`).
3. AWS processing consumes staged input or lifecycle event and creates derived artifacts.
4. Artifacts are versioned/stored in S3.
5. API domain exposes snapshot and sequential change-feed views for clients.
6. Local CLI pulls and updates Obsidian vault.

## 6. High-level Architecture

```text
Boox -> OneDrive -> Graph delta/webhook -> ingest handler -> processing pipeline -> S3 artifacts + manifests -> sync CLI -> Obsidian vault
```

### 6.1 Components

- **Ingress boundary:** provider-agnostic ingestion event contract plus OneDrive-specific adapter behavior, including source retrieval into staging.
- **Processing boundary:** PDF to markdown/image extraction pipeline that consumes ingress-domain events and publishes processing-owned read models.
- **Storage boundary:** S3 buckets/prefixes for originals, media, markdown, and manifests.
- **API boundary:** API-owned REST contract for CLI and site clients, including bootstrap snapshot and incremental change-feed access.
- **Sync boundary:** CLI pull using manifests and local checkpoint state.
- **Read boundary (future):** private site APIs protected by AWS auth controls.
- **Shared kernel:** only a narrow set of stable primitives reused unchanged across bounded contexts.

## 7. Data and Contract Principles

- Use stable note IDs derived from provider identifiers and content metadata.
- Use idempotency keys based on source item identity + content version indicators.
- Keep provider-specific payloads isolated in adapter components and emit normalized ingress-domain events into processing workflows.
- Publish public contracts from the package that owns the boundary and have consumers import from that owner.
- Version manifest schema explicitly.
- Treat the snapshot view and sequential change feed as client-facing contracts; keep raw storage layout internal.
- Support replay and backfill without destructive side effects.

## 8. Security and Trust Model

- Trust source events only after validation and reconciliation.
- Keep processing and storage behind AWS IAM boundaries.
- Do not rely on frontend route guards for true authorization.
- Future private site access must enforce authorization at API Gateway/Lambda boundaries.

## 9. Operational Requirements

- Retry-safe processing.
- Dead-letter handling for unrecoverable events.
- Observability for event receipt, process duration, failure rates, and sync lag.
- Manual replay support for specific source items.

## 10. Rollout Plan

### Phase 1

- OneDrive ingestion + AWS processing + S3 storage contracts.
- API-owned snapshot bootstrap and sequential change-feed endpoints.
- Manual pull sync CLI to Obsidian using change tokens/cursors.

### Phase 2

- Reliability hardening: replay tooling, metrics dashboards, policy tuning.
- Introduce note partitioning and pull policy controls so notes from different source folders can be split (for example home vs work) and selectively pulled by CLI policy.
- Harden CLI security requirements (credentials, token lifecycle, local cache policy, and audit-safe logging).

### Phase 3

- Private site read path using protected APIs and scoped claims.

## 11. Risks

- Graph webhook and delta reconciliation complexity.
- OCR quality variability for handwritten content.
- Artifact path churn causing Obsidian link instability.

## 12. Open Questions

- Should event ingress be pull-only first (delta polling) before webhook activation?
- Which PDF extraction stack balances quality, speed, and cost for handwritten notes?
- What retention policy should apply to intermediate processing artifacts?
- Should source-folder partition mapping be defined statically in config or dynamically via manifest metadata rules?
