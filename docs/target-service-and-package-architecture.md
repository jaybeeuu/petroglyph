# Target Service and Package Architecture

- **Status:** Accepted baseline
- **Created:** 2026-03-09
- **Related RFCs:** [0001](rfcs/0001-notes-platform-architecture.md), [0002](rfcs/0002-onedrive-ingestion-and-change-detection.md), [0003](rfcs/0003-pdf-processing-artifact-contracts-and-cli-sync.md), [0004](rfcs/0004-notes-api-and-client-contracts.md), [0005](rfcs/0005-cli-sync-mechanisms-and-local-materialization.md)
- **Related ADRs:** [0001](adrs/0001-client-sync-mechanism-and-sequence-checkpoint-model.md), [0002](adrs/0002-ingestion-provider-boundary-and-provider-scoped-note-ids.md), [0003](adrs/0003-storage-retention-and-read-model-ownership.md), [0004](adrs/0004-manifest-schema-and-versioning.md), [0005](adrs/0005-onedrive-stable-identity-strategy.md), [0006](adrs/0006-package-layout-and-ci-workflow.md), [0007](adrs/0007-auth-boundary-and-first-identity-provider.md), [0008](adrs/0008-sync-conflict-and-local-deletion-policy.md), [0009](adrs/0009-onedrive-graph-authentication-and-secret-storage.md), [0010](adrs/0010-artifact-delivery-mode.md), [0011](adrs/0011-application-user-domain-and-provider-connection-ownership.md)

## 1. Purpose

Map the accepted RFC set onto concrete bounded contexts, package ownership, and target AWS service choices so implementation can begin without reopening basic service-boundary decisions.

## 2. Package Layout

Implementation should live in a dedicated repository organized around a top-level `packages/` directory.
The repository should follow a domain-driven design approach: each package should align to a bounded context, own its internal types, and publish only the public contracts that other packages need.

Initial layout:

- `packages/core`
  - narrow shared kernel only
  - small, stable primitives which do not belong to a bounded context
  - generic helpers that do not shift contract ownership away from the owning service
- `packages/api`
  - authenticated REST API implementation
  - owns client-facing resource contracts for `/notes`, `/notes/changes`, note detail, metadata, versions, and artifacts
  - HTTP handlers for `/notes`, `/notes/changes`, note detail, metadata, versions, and artifacts
- `packages/ingest-onedrive`
  - OneDrive delta polling adapter
  - provider-specific retrieval into staging
  - owns and publishes the ingress-to-processing event contract it emits
- `packages/processor`
  - PDF processing and artifact generation
  - owns processing inputs, publication models, and sequence-backed read-model writes
- `packages/cli`
  - local materialization into Obsidian-compatible directory structures
  - checkpoint storage and monitored-folder filtering
- `packages/infra`
  - Terraform modules and environment composition for AWS deployment

This starts with a small number of packages. Further splitting is allowed later if one package becomes too broad.
Public contracts should be imported from the package that owns the corresponding boundary rather than copied into a third package that becomes the default focus of change.

## 3. Target AWS Services

### 3.1 API layer

- **API Gateway HTTP API**
  - lowest-friction managed HTTP entrypoint for the notes API
  - suitable for authenticated endpoints and Lambda integrations
- **AWS Lambda**
  - request handlers for API routes
  - avoids managing always-on compute in V1

### 3.2 Ingestion layer

- **EventBridge Scheduler**
  - drives delta polling on a fixed cadence for V1
  - chosen over webhook-first rollout to reduce initial operational complexity
- **AWS Lambda**
  - polling worker for OneDrive delta retrieval
  - staging writer and normalized lifecycle event producer
- **SQS**
  - decouples ingestion from processing
  - provides retry and backpressure support for downstream processing

### 3.3 Processing layer

- **AWS Lambda**
  - processes staged PDFs and generates artifacts
  - updates note state and change-feed entries
- **S3**
  - system of record for original PDFs, generated markdown, images, and metadata
- **DynamoDB**
  - current-state note view
  - sequence-backed change log metadata
  - checkpoint-safe change publication support

### 3.4 Security and configuration

- **AWS Secrets Manager**
  - application-level OneDrive/Graph secrets and auth-related secrets
- **CloudWatch Logs and Metrics**
  - ingestion, processing, and API observability

Authentication and token-validation boundaries should be implemented so Microsoft identity can be the first identity provider without coupling the rest of the platform irreversibly to Entra-specific assumptions.
If future requirements introduce additional identity providers, they should be addable behind the same API validation boundary and client contract.
The service-to-provider authentication boundary, application-user domain, and artifact delivery mode are now further constrained by [ADR 0009](adrs/0009-onedrive-graph-authentication-and-secret-storage.md), [ADR 0011](adrs/0011-application-user-domain-and-provider-connection-ownership.md), and [ADR 0010](adrs/0010-artifact-delivery-mode.md).
User-owned OneDrive connections should be modeled through delegated user consent to the platform-owned app registration rather than requiring users to exist inside the operator's tenant or register their own apps.

## 4. Initial Data Ownership

- **S3** owns binary and document artifacts.
- **DynamoDB** owns current note state and change-feed indexing metadata.
- **Clients** own their local checkpoints and local materialized copies.

This ownership split is locked by [ADR 0003](adrs/0003-storage-retention-and-read-model-ownership.md).

## 5. Sequence Generation

The accepted baseline is a single global monotonically increasing `sequence` for the change feed.
Implementation should allocate that sequence in a single authoritative write path so `/notes/changes` stays globally ordered.
A simple V1 approach is a DynamoDB-backed atomic counter owned by the processing/publication path.

## 6. Domain and Boundary Rules

- External identity providers authenticate users, but do not define the application-owned user model.
- The application-account domain owns authorization state and provider-connection ownership.
- The ingress domain owns provider-native identifiers, retrieval, staging references, and the public event contract emitted toward processing.
- The processing domain owns processing commands, artifact production, sequence allocation, and publication models written into storage.
- The API domain owns the client-facing REST resource contract even when it reads processing-owned publication models internally.
- The CLI domain owns local checkpoint and materialization rules.
- Public contracts should be published by the owning package and consumed from there.
- `packages/core` should remain a narrow shared kernel rather than the home for service-owned contracts.
- Processing and API packages must not depend on OneDrive-specific SDK types.

These boundaries are further constrained by [ADR 0005](adrs/0005-onedrive-stable-identity-strategy.md) and [ADR 0011](adrs/0011-application-user-domain-and-provider-connection-ownership.md).

## 7. V1 Technical Choices

These choices are considered the current implementation baseline:

- delta polling first, not webhook-first
- authenticated API from day one
- `/notes` as the current-state/bootstrap collection
- `/notes/changes` as the incremental change feed
- `sequence` as the stored client checkpoint model
- Microsoft identity as the first identity provider
- application accounts as the internal authorization boundary
- future additional identity providers remain possible without changing the core API contract
- delete as logical state, not physical artifact removal
- recreate after delete as same logical note, new version

## 8. Decisions Deferred

These are still expected to become ADRs or technical spikes:

- PDF/OCR extraction library stack
- exact Terraform environment/module decomposition
- exact persistence model for application-user and provider-connection records

## 9. Implementation Order

1. `packages/core`
2. `packages/ingest-onedrive`
3. `packages/processor`
4. `packages/api`
5. `packages/cli`
6. `packages/infra`

The order above reflects dependency direction, not necessarily deployment order.
Starting with `packages/core` does not imply centralizing service contracts there; it only establishes the narrow shared-kernel baseline before service-owned boundaries are implemented.
