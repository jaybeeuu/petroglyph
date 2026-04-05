# Plan: Petroglyph — Phase 1 PDF Sync

> Source: [ARCHITECTURE.md](../ARCHITECTURE.md), [docs/authentication.md](../docs/authentication.md)

## Architectural decisions

Durable decisions that apply across all phases:

- **Monorepo packages**: `packages/api`, `packages/ingest-onedrive`, `packages/processor`, `packages/plugin`, `packages/infra`, plus shared lib(s)
- **API routes**: `/auth/url`, `/auth/callback`, `/auth/refresh`, `/onedrive/auth-url`, `/onedrive/connect`, `/onedrive/lifecycle`, `/files/changes`, `/sync/run`, `/sync/reset`, `/status`
- **DynamoDB tables**: `users`, `refresh_tokens`, `sync_profiles`, `file_records`
- **SSM prefix**: `/petroglyph/`
- **Auth**: GitHub OAuth → cloud JWT + refresh token (rotate on use); OneDrive OAuth PKCE → tokens in SSM
- **Compute**: Lambda (Node.js 24 / TypeScript) behind API Gateway HTTP API
- **Storage**: S3 for staged PDFs, DynamoDB for state, SSM SecureString for credentials
- **IaC**: Terraform in `packages/infra`
- **Subscription lifecycle**: reactive only — Microsoft Graph sends `reauthorizationRequired` / `subscriptionRemoved` to the Lifecycle Notification Lambda; no scheduled renewer

---

## Phase 1: Infrastructure & Deployment Pipeline

**Goal**: Prove the full deployment pipeline end-to-end before writing any product logic.

### What to build

Scaffold all packages as empty shells with consistent tooling (build, lint, typecheck, test scripts). Provision core AWS infrastructure with Terraform: API Gateway (HTTP API), a single placeholder Lambda behind it, DynamoDB (tables defined but empty), S3 bucket, SSM parameters (stubs), and IAM execution roles. Set up GitHub Actions CI (lint, typecheck, test on PR) and CD (deploy Lambda + `terraform apply` on merge to main).

### Acceptance criteria

- [ ] All packages exist with consistent `package.json`, `tsconfig.json`, and build/lint/typecheck scripts
- [ ] `pnpm build`, `pnpm lint`, and `pnpm typecheck` pass from the repo root
- [ ] Terraform provisions all core resources without error
- [ ] CI pipeline runs on every PR and blocks merge on failure
- [ ] CD pipeline deploys to AWS on merge to main
- [ ] `curl <api-gateway-url>/health` returns `200 OK`

---

## Phase 2: Plugin Login (GitHub OAuth)

**Goal**: A user can log in to the cloud API from the Obsidian plugin using their GitHub account.

### What to build

Implement the GitHub OAuth flow end-to-end. The cloud API exposes `GET /auth/url` (returns the GitHub authorise URL with a `state` token) and `POST /auth/callback` (exchanges the code, looks up or creates the user in DynamoDB, issues a JWT + refresh token). `POST /auth/refresh` rotates the refresh token and issues a new JWT. The plugin adds a settings tab with a "Connect" button, registers the `obsidian://petroglyph/auth/callback` URI handler, stores the JWT + refresh token, and silently refreshes the JWT before expiry.

### Acceptance criteria

- [ ] Clicking "Connect" in plugin settings opens the browser to GitHub login
- [ ] After consent, the plugin receives the JWT and refresh token via the URI handler
- [ ] Plugin settings tab shows "Logged in as @{username}"
- [ ] A JWT that has expired is transparently refreshed without user action
- [ ] Using a superseded refresh token returns `401` and clears the plugin session
- [ ] `GET /status` returns `{ loggedIn: true, oneDriveStatus: "never_connected" }` for a newly connected user

---

## Phase 3: OneDrive Connection

**Goal**: A logged-in user can connect their OneDrive account and the service begins watching the configured folder.

### What to build

Implement the OneDrive PKCE OAuth flow. The cloud API exposes `GET /onedrive/auth-url` (generates PKCE verifier, stores it in DynamoDB, returns the Microsoft authorise URL) and `POST /onedrive/connect` (exchanges the code, stores access + refresh tokens in SSM, registers the Microsoft Graph change notification subscription for the configured folder, creates a default `SyncProfile` in DynamoDB). The plugin adds a "Connect OneDrive" button in settings and registers the `obsidian://petroglyph/oauth/callback` URI handler. `GET /status` reflects `oneDriveStatus: "connected"`.

### Acceptance criteria

- [ ] Clicking "Connect OneDrive" opens the browser to Microsoft login
- [ ] After consent, the plugin shows "OneDrive connected" in settings
- [ ] A Graph change notification subscription exists for the configured OneDrive folder (verifiable via Graph Explorer)
- [ ] `GET /status` returns `{ oneDriveStatus: "connected", subscriptionActive: true }`
- [ ] A default `SyncProfile` record exists in DynamoDB after connection
- [ ] OneDrive access token is lazy-refreshed when within 10 minutes of expiry

---

## Phase 4: File Ingestion (Webhook → S3)

**Goal**: A PDF saved to OneDrive by the Onyx Boox is automatically downloaded and staged in S3.

### What to build

Implement the Webhook Receiver Lambda (validates the Microsoft Graph change notification — including the initial validation token handshake — and enqueues a job to SQS) and the Processor Lambda (reads from SQS, downloads the PDF from OneDrive via Graph API, uploads to S3 under a key matching the OneDrive folder structure, writes a `file_records` DynamoDB item with status `pending`). Wire up the SQS DLQ and CloudWatch alarm.

### Acceptance criteria

- [ ] Microsoft Graph validation handshake succeeds when the subscription is registered
- [ ] Saving a PDF to the watched OneDrive folder triggers the webhook within seconds
- [ ] The PDF appears in S3 under the correct key path
- [ ] A `file_records` item exists in DynamoDB with status `pending`
- [ ] A failed Processor invocation lands in the DLQ
- [ ] A DLQ message triggers the CloudWatch alarm (verifiable via manual DLQ injection)

---

## Phase 5: Plugin File Sync

**Goal**: Pending PDFs are automatically pulled into the Obsidian vault by the plugin.

### What to build

The API Handler Lambda exposes `GET /files/changes?after={token}&limit={pageSize}` (returns an ordered page of file records as `{ files: [...], nextToken: string | null }`) and `POST /sync/run` (triggers the delta query Lambda to catch files missed by webhooks). `GET /files/changes` with no `after` token respects the `initial-sync` SSM config flag: if true, returns all files from the beginning; if false, returns an empty first page. The plugin polls `GET /files/changes` on a configurable interval. The "Sync Now" command calls `POST /sync/run` first then fetches changes. For each file in a page: download the PDF via pre-signed S3 URL, write it to the vault at the path defined by the active SyncProfile, create a companion `.md` file with YAML frontmatter, then advance the stored change token. The token is opaque, stored in plugin local settings per active profile, and advances file-by-file after each successful vault write. S3 objects are deleted after 90 days (configurable) via a lifecycle rule — purely time-based, no per-file delivery confirmation.

`POST /sync/reset` accepts a `scope` field (`"server"` or `"full"`):

- `"server"` — clears the Graph delta token and deletes file records in DynamoDB so the server re-fetches all OneDrive files on next `POST /sync/run`
- `"full"` — same as above, and additionally signals the plugin to clear its local change token

The plugin settings and command palette expose three reset commands:

- **Reset Plugin State** — clears the local change token; plugin re-downloads whatever is still in S3
- **Reset Server State** — calls `POST /sync/reset` with `scope: "server"`
- **Full Reset** — calls `POST /sync/reset` with `scope: "full"` and clears the local change token

### Acceptance criteria

- [ ] A PDF saved to OneDrive appears in the Obsidian vault within one polling interval (no user action)
- [ ] The PDF is placed at `handwritten/<OneDrive folder path>/<filename>.pdf`
- [ ] A companion `.md` file is created with correct frontmatter (`source`, `synced_at`, `created_at`, `page_count`, `tags: [handwritten]`)
- [ ] "Sync Now" calls `POST /sync/run` then pages through `GET /files/changes` until `nextToken` is null
- [ ] The plugin's change token advances after each individual file is written to the vault
- [ ] Restarting the plugin and syncing does not re-download already-processed files
- [ ] A file that already exists in the vault is overwritten with the OneDrive version
- [ ] S3 objects are deleted after 90 days (verifiable via lifecycle rule inspection); default is configurable via SSM
- [ ] **Reset Plugin State** clears the local change token; next sync re-downloads files still in S3
- [ ] **Reset Server State** (`POST /sync/reset` `scope: "server"`) causes the server to re-fetch all OneDrive files on next `POST /sync/run`
- [ ] **Full Reset** clears both server state and plugin token; full end-to-end re-process completes successfully

---

## Phase 6: Subscription Lifecycle & Reconnection

**Goal**: The service recovers gracefully from subscription expiry or token revocation, and the plugin guides the user through reconnection.

### What to build

Implement the Lifecycle Notification Lambda, reachable via a dedicated `lifecycleNotificationUrl` registered on the Graph subscription. On `reauthorizationRequired`: attempt lazy token refresh and subscription renewal; if that succeeds, no user action is needed; if it fails, mark `oneDriveStatus: "disconnected"` with a `reason` in DynamoDB. On `subscriptionRemoved`: mark disconnected immediately. The plugin's next `/status` poll detects the disconnected state and surfaces a labelled prompt explaining the reason, with a "Reconnect OneDrive" button that re-initiates the Phase 3 PKCE flow.

### Acceptance criteria

- [ ] A `reauthorizationRequired` notification triggers an automatic renewal attempt
- [ ] If renewal succeeds, `subscriptionActive` remains `true` and the plugin is unaffected
- [ ] If renewal fails, `oneDriveStatus` becomes `disconnected` in DynamoDB
- [ ] A `subscriptionRemoved` notification immediately sets `oneDriveStatus: "disconnected"`
- [ ] The plugin displays a contextual reconnect prompt (with reason) on next status poll after disconnection
- [ ] Completing the reconnect flow from the plugin restores `oneDriveStatus: "connected"` and re-registers the subscription

---

## Phase 7: Sync Profiles

**Goal**: A user can create and manage named sync profiles, each binding a specific OneDrive folder to a specific vault path.

### What to build

Extend the API with CRUD endpoints for sync profiles: `GET /profiles`, `POST /profiles`, `PUT /profiles/{id}`, `DELETE /profiles/{id}`. The plugin adds a Profiles section to its settings tab: list profiles, create new (pick OneDrive folder, vault destination path, settings), set one as active. The active profile ID is stored in plugin local settings. All file ingestion and sync operations are scoped to the active profile's source folder and destination path. Update the Graph subscription to watch the folder from the active profile.

### Acceptance criteria

- [ ] User can create a named sync profile via the plugin settings UI
- [ ] User can switch the active profile; subsequent syncs use the new profile's source and destination
- [ ] Deleting a profile does not delete already-synced files from the vault
- [ ] Profile definitions are read from the API on each plugin load (changes on one device propagate to others)
- [ ] The Graph subscription is updated when the active profile's source folder changes
