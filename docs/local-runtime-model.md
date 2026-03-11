# Local Runtime Model

This document describes the Petroglyph local development strategy:
what runs locally, what uses remote services, how mocked auth works,
and the expected process model for each package.

## Principle

Local testability is a first-class implementation requirement.
Every package must be runnable on a developer machine without requiring a fully deployed AWS stack or real cloud credentials.
The local default is mocked auth and lightweight process emulation.
Connecting to real remote services is an opt-in developer action, not the local default.

## What Runs Locally vs. Remotely

| Concern                   | Local development                       | Remote (deployed)           |
| ------------------------- | --------------------------------------- | --------------------------- |
| API server                | Node process via `tsx` or `pnpm dev`    | AWS Lambda + API Gateway    |
| Ingest poller             | Node process via `tsx` or `pnpm dev`    | AWS Lambda + EventBridge    |
| Processor worker          | Node process via `tsx` or `pnpm dev`    | AWS Lambda + SQS trigger    |
| CLI                       | Node process via `tsx` or `pnpm dev`    | Installed binary            |
| Auth token validation     | Mocked (`AUTH_MODE=mock`)               | Microsoft Entra OIDC        |
| OneDrive Graph access     | File fixtures or manual override        | Live Microsoft Graph API    |
| S3 storage                | LocalStack (optional) or in-memory stub | AWS S3                      |
| SQS messaging             | LocalStack (optional) or in-memory stub | AWS SQS                     |
| DynamoDB state            | LocalStack (optional) or in-memory stub | AWS DynamoDB                |
| Secrets                   | `.env` file (local only, gitignored)    | AWS Secrets Manager         |
| Observability             | Console logs                            | CloudWatch Logs and Metrics |

## Local Process Model

Each package runs as a plain Node.js process using `tsx` for TypeScript execution.
No Lambda simulation or serverless framework is required for local development.

### API Package (`packages/api`)

Runs as an HTTP server on `API_PORT` (default `3000`).

```sh
pnpm --filter @petroglyph/api dev
```

When `AUTH_MODE=mock`, the API accepts all requests without token validation.
When `AUTH_MODE=entra`, the API validates Entra-issued tokens on protected routes.

### Ingest-OneDrive Package (`packages/ingest-onedrive`)

Runs as a polling loop that checks OneDrive for delta changes and emits events.
In local development, the polling interval is shorter and OneDrive can be substituted with file fixtures.

```sh
pnpm --filter @petroglyph/ingest-onedrive dev
```

### Processor Package (`packages/processor`)

Consumes ingest events, processes PDFs, and writes artifacts.
In local development, reads from a local queue stub or directly from a fixture directory.

```sh
pnpm --filter @petroglyph/processor dev
```

### CLI Package (`packages/cli`)

A command-line tool for syncing notes from the API into a local Obsidian vault.
In local development, targets the local API at `CLI_API_BASE_URL` (default `http://localhost:3000`).

```sh
pnpm --filter @petroglyph/cli dev
```

Or for one-off sync:

```sh
pnpm --filter @petroglyph/cli exec tsx src/index.ts sync
```

## Mocked Auth Strategy

Early local development uses `AUTH_MODE=mock` to remove the Entra dependency from the development loop.

When mock auth is active:
- The API accepts all requests and treats them as authenticated with a synthetic identity.
- The CLI skips the OAuth flow and uses a local stub token.
- No Entra app registration or credentials are needed.

When you are ready to test real Entra flows, set `AUTH_MODE=entra` and provide `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, and optionally `ENTRA_AUTHORITY` in your `.env` file.
See [docs/environment-variables.md](./environment-variables.md) for the full reference.

## Local AWS Emulation

AWS-dependent packages (ingest, processor, API) can be developed without a real AWS account by using one of two approaches:

### Approach 1: In-process stubs (default)

Each package provides local stubs for S3, SQS, and DynamoDB when `NODE_ENV=development` and no real AWS credentials are present.
Stubs hold state in memory for the lifetime of the process and reset on restart.

### Approach 2: LocalStack (optional)

[LocalStack](https://localstack.cloud/) emulates AWS services locally on port `4566`.
To activate LocalStack integration, set `AWS_ENDPOINT_URL=http://localhost:4566` in your `.env`.

LocalStack is not required for local development.
Use it when you need persistent state between restarts, realistic AWS API behavior, or Terraform-driven setup.

## Unified Local Dev Workflow

To start all packages together in development mode:

```sh
pnpm dev
```

This runs the `dev` script in every package that defines one, in dependency order.

To start a single package:

```sh
pnpm --filter @petroglyph/<name> dev
```

## Environment Variable Handling

Copy `.env.example` to `.env` at the repository root before starting local development:

```sh
cp .env.example .env
```

Edit `.env` to match your local setup.
The minimum working set for a mocked local session requires no cloud credentials.
See [docs/environment-variables.md](./environment-variables.md) for details.

## State and Reset

Local in-memory state resets automatically when processes restart.
LocalStack state persists across restarts unless you recreate the container.

To reset LocalStack state:

```sh
docker compose down && docker compose up -d
```

## Failure Modes

| Symptom                                 | Likely cause                                                  | Fix                                                       |
| --------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| `AUTH_MODE` not recognized              | Variable not set or `.env` not loaded                         | Check `.env` exists and `AUTH_MODE` is set correctly      |
| API rejects all requests                | `AUTH_MODE=entra` without valid Entra config                  | Switch to `AUTH_MODE=mock` or provide Entra credentials   |
| AWS SDK call fails with endpoint error  | Missing `AWS_ENDPOINT_URL` when using LocalStack              | Set `AWS_ENDPOINT_URL=http://localhost:4566`              |
| OneDrive poller fails to authenticate   | Missing `ONEDRIVE_CLIENT_ID` or `ONEDRIVE_CLIENT_SECRET`      | Add credentials to `.env` or use file fixtures            |
| Port already in use                     | Another process is using `API_PORT`                           | Change `API_PORT` in `.env` or stop the conflicting process |
