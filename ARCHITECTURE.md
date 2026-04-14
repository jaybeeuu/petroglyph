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
```

---

## Components

### 1. Cloud Service (AWS)

#### Compute — Lambda Functions

| Function                           | Trigger                  | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Webhook Receiver**               | API Gateway              | Validates MS Graph change notification, returns 200 fast, enqueues job to SQS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Processor**                      | SQS                      | Consumes queued OneDrive notifications, resolves DriveItem metadata before download, refreshes tokens via the SSM contract, skips non-PDF/non-downloadable items, uploads staged PDFs to S3 under the configured prefix plus OneDrive folder path, and writes file-record status to DynamoDB. See `packages/processor/src/index.ts` for staged-file contract and processing logic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **API Handler**                    | API Gateway              | Serves plugin requests: session status (`GET /status`), OneDrive auth URL (`GET /onedrive/auth-url`), OneDrive connection callback (`POST /onedrive/connect`), list pending files, issue pre-signed S3 URLs, acknowledge delivery, **manual sync** (`POST /sync/run`), **sync state reset** (`POST /sync/reset`), and **profile management** (`GET/POST /profiles`, `GET/PUT/DELETE /profiles/:id`). The `/sync/run` endpoint is authenticated, reads the OneDrive delta token from SSM, pages through Graph delta responses, and for each new or changed PDF item, creates a `file_records` DynamoDB item with placeholder `s3Key`, queued metadata, and pending status. Non-PDF items are skipped. The endpoint returns the count of queued items. The `/sync/reset` endpoint accepts `{ "scope": "server" \| "full" }` and clears server-side Graph delta token and file records; `scope: "full"` additionally signals the plugin to clear its local change token via the `resetToken` response field. The `/status` endpoint may return `oneDriveStatus: 'reconnect_required'` if user action is needed to restore OneDrive connectivity. A Hono middleware intercepts all `/onedrive/*` routes to perform lazy token refresh and inject the current OneDrive access token into the request context (see [docs/authentication.md](docs/authentication.md#token-lifecycle)). |
| **Lifecycle Notification Handler** | API Gateway              | Handles Microsoft Graph lifecycle events (`subscriptionRemoved`, `reauthorizationRequired`) — attempts automatic renewal where possible; marks OneDrive as disconnected in DynamoDB if recovery fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Manual Sync**                    | CLI invocation (AWS SDK) | Runs a Graph delta query to catch any files missed by webhooks; processes any unsynced files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

All Lambda functions use **Node.js 24 / TypeScript**, consistent with the monorepo.

#### Storage

| Service                                | Purpose                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S3**                                 | Staged PDFs. Objects are keyed as `<staged-prefix>/<OneDrive folder path>/<filename>.pdf`, preserving the source folder hierarchy for the plugin. Lifecycle rule deletes objects 90 days after staging (configurable via the `retention_days` Terraform variable). Purely time-based — no per-file delivery confirmation. |
| **DynamoDB**                           | File records (path, S3 key, sequence position for change feed), Graph delta token for sync runs, subscription metadata, sync profile records (including `oneDriveConnected` flag read by `GET /status`).                                                                                                                  |
| **SSM Parameter Store (SecureString)** | OneDrive OAuth tokens, GitHub App credentials, configuration values. Zero standing cost.                                                                                                                                                                                                                                  |

Exactly one sync profile per user is `active` at any time. The first profile created is automatically set active; subsequent profiles are not. When an active profile is deleted, the API promotes the most-recently-created remaining profile to active. Deleting a profile also cascades deletion of its associated `file_records` to prevent orphaned DynamoDB data.

#### Messaging & Eventing

| Service                         | Purpose                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **SQS Ingestion Queue**         | Decouples webhook receiver from processor. Allows Graph notification to be acknowledged immediately. |
| **SQS Dead-Letter Queue (DLQ)** | Captures failed processor invocations for inspection and replay.                                     |

The Processor Lambda is triggered by the ingestion queue via an SQS event source mapping. The queue is configured with a visibility timeout that safely exceeds the processor Lambda timeout, ensuring failed jobs are not double-processed. Failed deliveries are automatically sent to the DLQ, which is monitored by a CloudWatch alarm. When a message lands in the DLQ, the alarm fires and sends an SNS email notification, providing the operational signal for stuck ingest work. The processor Lambda's environment is wired with `MICROSOFT_CLIENT_ID`, `STAGED_PDFS_BUCKET`, and `STAGED_PDF_PREFIX`; it reuses the existing SSM token contract for lazy OneDrive refresh. Webhook route and output updates are reflected in the Terraform configuration.

#### Observability

- **CloudWatch Logs** on all Lambda functions.
- **CloudWatch Alarm** on DLQ depth — fires when a message lands in the DLQ.
- **SNS** sends email notification when the alarm fires.

#### Infrastructure as Code

All AWS resources are provisioned with **Terraform**, with state stored remotely in S3 (with DynamoDB locking). Each deployment environment (`staging`, `production`) is a separate Terraform workspace, which isolates state and embeds the environment name into every resource name and tag. The S3 bucket and DynamoDB table that back the remote state are a one-time manual bootstrap prerequisite — see [`packages/infra/README.md`](packages/infra/README.md). SSM parameters are defined as Terraform stubs with `PLACEHOLDER` values; real secrets must be written to each parameter manually after first `terraform apply` before the service will function. The exception is `config/retention-days`, which is pre-seeded to `90` as a safe default.

#### CD Pipeline

Deployments to production are automated via `.github/workflows/cd.yml`, triggered on every push to `main`. The pipeline runs three sequential jobs:

| Job       | Steps                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `build`   | `pnpm install` → `pnpm build` → `pnpm test`                                                                                                                                                      |
| `package` | `pnpm --filter @petroglyph/api package` → uploads `lambda-<sha>.zip` to S3 (`LAMBDA_ARTIFACT_BUCKET`)                                                                                            |
| `deploy`  | Downloads artifact, runs `terraform init` (S3 backend + DynamoDB locking), selects/creates the `production` workspace, runs `terraform apply` with `api_zip_s3_bucket` and `api_zip_s3_key` vars |

AWS access in the `deploy` job uses OIDC — no long-lived credentials are stored. The GitHub Actions role ARN is provided via the `AWS_ROLE_ARN` secret on the `production` environment.

The `deploy` job targets the `production` GitHub Actions environment, which can restrict deploys to `main` and require reviewer approval before production deployment proceeds.

Required secrets: `AWS_ROLE_ARN`, `TF_STATE_BUCKET`, `LAMBDA_ARTIFACT_BUCKET` — see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

### 2. Obsidian Plugin

A TypeScript plugin that runs inside Obsidian, responsible for pulling staged files from the cloud service and writing them into the vault.

#### Behaviour

- **File sync** — calls `GET /files/changes?after={token}` to retrieve a page of new files as `{ files, nextToken }`.
  - The `after` token is an opaque cursor, stored in plugin local settings per active profile, and advances after each successful vault write.
  - If no token is stored, behaviour is controlled by the `initial-sync` config flag (see below).
  - Each file record includes a presigned S3 URL for direct download.
  - Paging is cursor-based: the response includes a `nextToken` if more files remain, or `null` if at the end.
  - The endpoint enforces authentication and validates all parameters with Zod.
  - On initial sync, if `initial-sync` is `true`, all files are returned from the beginning; if `false`, the first page is empty and only new files appear on subsequent syncs.
- **Manual "Sync Now" command** — available via command palette and settings. Calls `POST /sync/run` first (triggers a Graph delta query on the server to catch any webhook-missed files), then pages through `GET /files/changes` as above.
- **Reset operations** — available via command palette and settings:
  - _Reset Plugin State_ (local only) — clears the local change token for the active profile; plugin re-downloads files still in S3. No server call.
  - _Reset Server State_ (server only) — calls authenticated `POST /sync/reset` with `{ "scope": "server" }`; server deletes its stored Graph delta token and default-profile file records, returns `{ "resetToken": false }`, and re-fetches all OneDrive files on the next sync run. Plugin state unchanged.
  - _Full Reset_ (server + local) — calls the same endpoint with `{ "scope": "full" }`; server clears the same state, returns `{ "resetToken": true }`, and the plugin also clears its local change token.
- **Authentication** — GitHub OAuth against the cloud API (via API Gateway). The plugin schedules a proactive JWT refresh (via `window.setTimeout`) 5 minutes before the JWT expires; the timer is cancelled on `onunload`. On refresh failure the plugin lets the session expire naturally.
- **OneDrive connection** — A **"Connect OneDrive"** button in plugin settings calls `GET /onedrive/auth-url` (JWT-protected), opens the returned Microsoft login URL in the browser, and waits for the `obsidian://petroglyph/oauth/callback` URI redirect. The URI handler extracts `code` and `state` then calls `POST /onedrive/connect` (JWT Bearer) to complete the PKCE exchange. On success the plugin sets `oneDriveConnected=true` and persists it via Obsidian's `saveData` API. While connected, the settings tab shows **"OneDrive connected ✓"** and a placeholder Disconnect button.
- **Status polling & reconnect** — The plugin polls `GET /status` every 60 seconds (idempotent `setInterval`) whenever a JWT is present. If the response includes `oneDriveStatus: 'reconnect_required'`, the settings tab displays a persistent warning banner: `OneDrive connection lost — action required`, along with a `Reconnect OneDrive` button. Clicking this button re-initiates the OneDrive PKCE connect flow. The banner persists until status returns to `connected`. The `oneDrive.connected` value from the response is persisted via `saveData`. The interval is cancelled in `onunload` and `clearCredentials`.
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

The plugin writes files to the local vault; how the user syncs or backs up their vault is their own concern — the cloud service does not write to the vault directly.

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

- Webhook-driven ingestion: OneDrive → SQS → S3, with a DLQ and alarm for failed processor runs. Staged S3 keys preserve the OneDrive folder structure beneath the configured prefix.
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

| Decision              | Choice                                       | Rationale                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook vs polling    | Webhook (Graph change notifications)         | Near-realtime, no polling overhead                                                                                                                                                                                   |
| Webhook + manual sync | Safety net for missed notifications          | Reliability without scheduled cost                                                                                                                                                                                   |
| Plugin architecture   | Plugin pulls, cloud stages                   | Decouples vault writes from cloud service                                                                                                                                                                            |
| File transfer         | Pre-signed S3 URLs                           | Avoids proxying bytes through Lambda                                                                                                                                                                                 |
| Compute               | Lambda                                       | Zero cost at rest, scales to zero                                                                                                                                                                                    |
| State store           | DynamoDB                                     | Serverless, zero cost at rest                                                                                                                                                                                        |
| Secrets               | SSM Parameter Store                          | Free, encrypted, IAM-controlled                                                                                                                                                                                      |
| IaC                   | Terraform                                    | Already in use in this repo                                                                                                                                                                                          |
| Runtime               | Node.js 24 / TypeScript                      | Consistent with monorepo                                                                                                                                                                                             |
| Subscription renewal  | Reactive via Graph lifecycle notifications   | No standing scheduler; `reauthorizationRequired` triggers auto-renewal attempt; `subscriptionRemoved` prompts user reconnect via plugin                                                                              |
| Error alerting        | SQS DLQ + CW Alarm + SNS email               | Robust failure capture with near-zero cost                                                                                                                                                                           |
| Lambda packaging      | `cp -rL` to dereference symlinks before zip  | pnpm stores dependencies as symlinks; Lambda cannot resolve them. The `package` script in `packages/api` stages a fully dereferenced copy before zipping.                                                            |
| Environment isolation | Terraform workspaces in a single AWS account | Separate AWS accounts per environment add significant operational overhead for a personal project. Workspace-based resource naming (e.g. `petroglyph-users-production`) provides sufficient isolation at this scale. |
