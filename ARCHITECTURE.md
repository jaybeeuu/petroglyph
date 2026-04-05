# Petroglyph — High-Level Architecture

> A notes-processing system that automatically ingests handwritten PDFs from an Onyx Boox device (via OneDrive) and makes them available to a GitHub-backed Obsidian vault.

---

## Problem Statement

The Onyx Boox Note Air 5C saves handwritten notes as PDFs to OneDrive. The goal is to get those PDFs (and eventually OCR'd text and extracted diagrams) into an Obsidian vault backed by a GitHub repository — automatically, reliably, and at near-zero cost when idle.

---

## High-Level Data Flow

```
Onyx Boox Note Air 5C
        │
        │ (device syncs automatically)
        ▼
    OneDrive
        │
        │ Microsoft Graph change notification (webhook)
        ▼
 API Gateway (HTTP API)
        │
        ▼
 Webhook Receiver Lambda ──── validates & enqueues ────▶ SQS Ingestion Queue
                                                                │
                                                                ▼
                                                      Processor Lambda
                                                       │           │
                                             downloads from    writes record
                                               OneDrive           │
                                                  │               ▼
                                                  │           DynamoDB
                                                  │      (file records +
                                                  │       delivery state +
                                                  │        delta token)
                                                  │
                                                  ▼
                                              S3 Bucket
                                           (staged PDFs)
                                                  │
                                                  │ pre-signed URL
                                                  ▼
                                         Obsidian Plugin
                                       (polls Cloud API)
                                                  │
                                    writes PDF + Markdown stub
                                                  │
                                                  ▼
                                         Obsidian Vault
                                                  │
                                         obsidian-git / native sync
                                                  │
                                                  ▼
                                          GitHub Repository
```

---

## Components

### 1. Cloud Service (AWS)

#### Compute — Lambda Functions

| Function                           | Trigger                  | Responsibility                                                                                                                                                                                        |
| ---------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Webhook Receiver**               | API Gateway              | Validates MS Graph change notification, returns 200 fast, enqueues job to SQS                                                                                                                         |
| **Processor**                      | SQS                      | Downloads PDF from OneDrive, uploads to S3, writes file record to DynamoDB, generates Markdown frontmatter stub                                                                                       |
| **API Handler**                    | API Gateway              | Serves plugin requests: list pending files, issue pre-signed S3 URLs, acknowledge delivery                                                                                                            |
| **Lifecycle Notification Handler** | API Gateway              | Handles Microsoft Graph lifecycle events (`subscriptionRemoved`, `reauthorizationRequired`) — attempts automatic renewal where possible; marks OneDrive as disconnected in DynamoDB if recovery fails |
| **Manual Sync**                    | CLI invocation (AWS SDK) | Runs a Graph delta query to catch any files missed by webhooks; processes any unsynced files                                                                                                          |

All Lambda functions use **Node.js 24 / TypeScript**, consistent with the monorepo.

#### Storage

| Service                                | Purpose                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **S3**                                 | Staged PDFs. Lifecycle rule deletes objects 90 days after staging (configurable via SSM). Purely time-based — no per-file delivery confirmation. |
| **DynamoDB**                           | File records (path, S3 key, sequence position for change feed), Graph delta token for sync runs, subscription metadata.                          |
| **SSM Parameter Store (SecureString)** | OneDrive OAuth tokens, GitHub App credentials, configuration values. Zero standing cost.                                                         |

#### Messaging & Eventing

| Service                         | Purpose                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **SQS Ingestion Queue**         | Decouples webhook receiver from processor. Allows Graph notification to be acknowledged immediately. |
| **SQS Dead-Letter Queue (DLQ)** | Captures failed processor invocations for inspection and replay.                                     |

#### Observability

- **CloudWatch Logs** on all Lambda functions.
- **CloudWatch Alarm** on DLQ depth — fires when a message lands in the DLQ.
- **SNS** sends email notification when the alarm fires.

#### Infrastructure as Code

All AWS resources are provisioned with **Terraform**.

---

### 2. Obsidian Plugin

A TypeScript plugin that runs inside Obsidian, responsible for pulling staged files from the cloud service and writing them into the vault.

#### Behaviour

- **File sync** — calls `GET /files/changes?after={token}` to retrieve a page of new files as `{ files, nextToken }`. The change token is opaque, stored in plugin local settings per active profile, and advances file-by-file after each successful vault write. With no stored token, behaviour is controlled by the `initial-sync` config flag.
- **Manual "Sync Now" command** — calls `POST /sync/run` first (triggers a Graph delta query on the server to catch any webhook-missed files), then pages through `GET /files/changes`.
- **Reset operations** — available from plugin settings and the command palette:
  - _Reset Plugin State_ — clears the local change token; plugin re-downloads files still in S3.
  - _Reset Server State_ — calls `POST /sync/reset` (`scope: "server"`); server clears its Graph delta token and file records, re-fetching all OneDrive files on next sync run.
  - _Full Reset_ — both of the above.
- **Authentication** — GitHub OAuth against the cloud API (via API Gateway).
- **File download** — receives a list of pending files with pre-signed S3 URLs; downloads PDFs directly from S3.
- **Vault placement** — mirrors the OneDrive folder structure under a configurable root path (default: `handwritten/`). E.g. `OnyxBoox/Meeting Notes/` → `handwritten/OnyxBoox/Meeting Notes/`.
- **Conflict handling** — OneDrive version always wins; existing vault files are overwritten.
- **Deletion** — configurable: optionally remove vault files when the OneDrive source is deleted.
- **Acknowledgement** — notifies the cloud API on successful download; the API marks the file as delivered in DynamoDB.
- **Markdown stub** — creates a companion `.md` file alongside each PDF containing YAML frontmatter extracted from the PDF metadata (title, creation date, page count, source path, etc.).

#### Plugin Location

Lives in this monorepo during initial development. Will be extracted to its own repository before community plugin submission.

---

### 3. GitHub Integration

The vault is a GitHub-backed Obsidian repository. The plugin writes files to the local vault; committing to GitHub is handled by **obsidian-git** (or Obsidian's native sync) — the cloud service does not commit to GitHub directly in Phase 1.

A **GitHub App** (rather than a PAT) is registered for the service. This gives fine-grained repository permissions and a clear audit trail, and prepares the service for any future phase where cloud-side commits are needed.

---

## Folder Structure (Vault)

```
<vault-root>/
└── handwritten/               ← configurable root
    └── <OneDrive folder path>/
        ├── my-note.pdf
        └── my-note.md         ← companion stub with frontmatter
```

Example frontmatter:

```yaml
---
source: OnyxBoox/Meeting Notes/my-note.pdf
synced_at: 2026-04-03T20:00:00Z
created_at: 2026-04-03T10:15:00Z
page_count: 3
tags:
  - handwritten
---
```

---

## Phased Delivery

### Phase 1 — PDF Sync (current scope)

- Webhook-driven ingestion: OneDrive → S3.
- Plugin polls API, downloads PDFs, writes to vault.
- Markdown companion with frontmatter from PDF metadata.
- Manual sync CLI as safety net.

### Phase 2 — OCR & Enrichment

- An additional Lambda triggered by S3 `ObjectCreated` events.
- Runs OCR on the PDF (e.g. Amazon Textract or a third-party service).
- Extracts diagrams and embedded images.
- Updates DynamoDB record with enriched content.
- Plugin downloads the enriched Markdown alongside the PDF.

### Phase 3 — Multi-User / SaaS

- User authentication and account management.
- Per-user OAuth token storage (OneDrive, GitHub, future providers).
- Configurable source/destination provider pairs (add Dropbox, Google Drive, etc.).
- Plugin login flow replaces hardcoded credentials.

---

## Cost Profile

Designed to be **zero cost at rest**. All charges are usage-based:

| Component              | Standing Cost      | Usage Cost                  |
| ---------------------- | ------------------ | --------------------------- |
| Lambda                 | $0                 | Per invocation + GB-seconds |
| API Gateway (HTTP API) | $0                 | Per request                 |
| SQS                    | $0                 | Per request (1M free/month) |
| DynamoDB (on-demand)   | $0                 | Per read/write unit         |
| S3                     | $0                 | Per GB stored + requests    |
| SSM Parameter Store    | $0                 | Standard tier is free       |
| CloudWatch Alarm       | ~$0.10/alarm/month | —                           |
| SNS email              | $0                 | First 1K emails/month free  |

At personal-project volume, total monthly cost is expected to be **< $1**.

---

## Key Design Decisions

| Decision              | Choice                                     | Rationale                                                                                                                               |
| --------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook vs polling    | Webhook (Graph change notifications)       | Near-realtime, no polling overhead                                                                                                      |
| Webhook + manual sync | Safety net for missed notifications        | Reliability without scheduled cost                                                                                                      |
| Plugin architecture   | Plugin pulls, cloud stages                 | Decouples vault writes from cloud service; lets obsidian-git own commits                                                                |
| File transfer         | Pre-signed S3 URLs                         | Avoids proxying bytes through Lambda                                                                                                    |
| Compute               | Lambda                                     | Zero cost at rest, scales to zero                                                                                                       |
| State store           | DynamoDB                                   | Serverless, zero cost at rest                                                                                                           |
| Secrets               | SSM Parameter Store                        | Free, encrypted, IAM-controlled                                                                                                         |
| IaC                   | Terraform                                  | Already in use in this repo                                                                                                             |
| Runtime               | Node.js 24 / TypeScript                    | Consistent with monorepo                                                                                                                |
| Subscription renewal  | Reactive via Graph lifecycle notifications | No standing scheduler; `reauthorizationRequired` triggers auto-renewal attempt; `subscriptionRemoved` prompts user reconnect via plugin |
| Error alerting        | SQS DLQ + CW Alarm + SNS email             | Robust failure capture with near-zero cost                                                                                              |
