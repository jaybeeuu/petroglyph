# ADR Index

This folder tracks architecture decisions promoted from RFC discussion.

## MADR Guidance

Use [MADR](https://github.com/adr/madr) as the default format for ADRs in this folder.

### Why MADR

- Keeps decisions readable and comparable over time.
- Encourages explicit alternatives and consequences.
- Makes revisits and supersession easier when requirements change.

### File Naming

- Use numeric prefixes with kebab-case names.
- Pattern: `0001-short-decision-name.md`.
- Never rename an accepted ADR number; supersede with a new ADR instead.

### Recommended MADR Sections

Use this order unless there is a strong reason to deviate:

1. Title
2. Status
3. Context
4. Decision Drivers
5. Considered Options
6. Decision Outcome
7. Consequences
8. Validation
9. Links

### Status Lifecycle

- `Proposed` while drafting.
- `Accepted` when approved for implementation.
- `Superseded by XXXX` when replaced by a newer ADR.
- `Deprecated` when no longer recommended but still historically relevant.

### How to Use with RFCs

- Draft decisions in RFCs first.
- Promote stable decisions into ADRs using MADR structure.
- Cross-link both ways:
  - RFC references the ADR for the final decision.
  - ADR references the originating RFC section.
- If implementation changes the decision, update ADR status and add a new ADR rather than rewriting history.

### Minimal Checklist Before Accepting an ADR

- Scope is narrow and decision is explicit.
- At least two options are compared.
- Consequences (positive and negative) are documented.
- Validation approach is stated (tests, metrics, operational checks, or rollout gates).
- Related RFC and issue links are present.

## Planned ADR Candidates

- PDF/OCR extraction stack.
- Terraform environment and module decomposition.
- Provider credential retention and disconnection lifecycle, if not fully covered by ADR 0011.

## Accepted ADRs

- [0001 Client Sync Mechanism and Sequence Checkpoint Model](0001-client-sync-mechanism-and-sequence-checkpoint-model.md) — `Accepted`
- [0002 Ingestion Provider Boundary and Provider-Scoped Note IDs](0002-ingestion-provider-boundary-and-provider-scoped-note-ids.md) — `Accepted`
- [0003 Storage Retention and Read-Model Ownership](0003-storage-retention-and-read-model-ownership.md) — `Accepted`
- [0004 Manifest Schema and Versioning](0004-manifest-schema-and-versioning.md) — `Accepted`
- [0005 OneDrive Stable Identity Strategy](0005-onedrive-stable-identity-strategy.md) — `Accepted`
- [0006 Package Layout and CI Workflow](0006-package-layout-and-ci-workflow.md) — `Accepted`
- [0007 Auth Boundary and First Identity Provider](0007-auth-boundary-and-first-identity-provider.md) — `Accepted`
- [0008 Sync Conflict and Local Deletion Policy](0008-sync-conflict-and-local-deletion-policy.md) — `Accepted`
- [0009 OneDrive Graph Authentication and Secret Storage](0009-onedrive-graph-authentication-and-secret-storage.md) — `Accepted`
- [0010 Artifact Delivery Mode](0010-artifact-delivery-mode.md) — `Accepted`
- [0011 Application User Domain and Provider Connection Ownership](0011-application-user-domain-and-provider-connection-ownership.md) — `Accepted`
- [0012 Repository Tooling Baseline and Validation Stack](0012-repository-tooling-baseline-and-validation-stack.md) — `Accepted`

## Recommended ADR Order

No additional high-priority ADRs are currently queued before task decomposition.

The accepted sync, ingestion, storage, schema, identity, workflow, auth, local-sync-policy, provider-auth, artifact-delivery, application-user-domain, and tooling-baseline ADRs should be treated as implementation prerequisites for API and CLI work.

## Template

Each ADR should include at minimum:

1. Status
2. Context
3. Decision
4. Consequences
5. Alternatives considered
6. Rollback or revisit trigger
