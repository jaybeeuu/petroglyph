# Environment Variables

All environment variables used by Petroglyph packages are documented here.
Copy `.env.example` to `.env` in the repository root and fill in the values for your local setup.
Never commit `.env` to source control.

## Loading

Packages load environment variables at startup.
In local development, use a `.env` file at the repository root.
In CI and production, set variables through the host environment or secrets manager directly.

## Reference

### Runtime

| Variable   | Default       | Required | Description                                                  |
| ---------- | ------------- | -------- | ------------------------------------------------------------ |
| `NODE_ENV` | `development` | No       | Runtime environment. Use `production` for deployed services. |

### API Package

| Variable      | Default       | Required | Description                                                  |
| ------------- | ------------- | -------- | ------------------------------------------------------------ |
| `API_PORT`    | `3000`        | No       | Port the local API server listens on.                        |
| `LOG_LEVEL`   | `info`        | No       | Log verbosity. One of: `error`, `warn`, `info`, `debug`.     |
| `AUTH_MODE`   | `mock`        | No       | Auth strategy. `mock` disables real token validation for local dev. Use `entra` for real validation. |

### Entra (API and CLI, required when `AUTH_MODE=entra`)

| Variable          | Default                                              | Required              | Description                                      |
| ----------------- | ---------------------------------------------------- | --------------------- | ------------------------------------------------ |
| `ENTRA_TENANT_ID` | —                                                    | When `AUTH_MODE=entra` | Azure AD tenant ID for the platform app registration. |
| `ENTRA_CLIENT_ID` | —                                                    | When `AUTH_MODE=entra` | Application (client) ID of the Entra app.        |
| `ENTRA_AUTHORITY` | `https://login.microsoftonline.com/common`           | No                    | Entra authority URL. Override for specific tenant validation. |

### Ingest-OneDrive Package

| Variable                  | Default | Required                   | Description                                               |
| ------------------------- | ------- | -------------------------- | --------------------------------------------------------- |
| `ONEDRIVE_CLIENT_ID`      | —       | For OneDrive polling       | Application (client) ID for the Graph app registration.   |
| `ONEDRIVE_CLIENT_SECRET`  | —       | For OneDrive polling       | Client secret for the Graph app. Store in Secrets Manager in production. |
| `ONEDRIVE_TENANT_ID`      | —       | For OneDrive polling       | Tenant ID for delegated user token refresh.               |

### AWS (Ingest, Processor, and API Packages)

| Variable                    | Default        | Required          | Description                                                     |
| --------------------------- | -------------- | ----------------- | --------------------------------------------------------------- |
| `AWS_REGION`                | —              | For AWS services  | AWS region. Example: `eu-west-1`.                               |
| `AWS_ACCESS_KEY_ID`         | —              | For AWS services  | AWS access key. Omit when using IAM roles or LocalStack defaults. |
| `AWS_SECRET_ACCESS_KEY`     | —              | For AWS services  | AWS secret key. Omit when using IAM roles or LocalStack defaults. |
| `AWS_ENDPOINT_URL`          | —              | No                | Override the AWS endpoint. Set to `http://localhost:4566` when using LocalStack for local emulation. |
| `PETROGLYPH_S3_BUCKET`      | —              | For S3 access     | S3 bucket name for originals and derived artifacts.             |
| `PETROGLYPH_SQS_QUEUE_URL`  | —              | For SQS messaging | SQS queue URL for ingest-to-processor messages.                 |
| `PETROGLYPH_DYNAMODB_TABLE` | —              | For DynamoDB      | DynamoDB table name for note state and change-feed metadata.    |

### CLI Package

| Variable              | Default                   | Required | Description                                                        |
| --------------------- | ------------------------- | -------- | ------------------------------------------------------------------ |
| `CLI_API_BASE_URL`    | `http://localhost:3000`   | No       | Base URL of the notes API. Override when targeting a deployed API. |
| `OBSIDIAN_VAULT_PATH` | —                         | For sync | Absolute path to the local Obsidian vault directory.               |

## Local Development Defaults

For a local-only development session using mocked auth and no real AWS services, the minimum working set is:

```sh
NODE_ENV=development
AUTH_MODE=mock
API_PORT=3000
LOG_LEVEL=info
CLI_API_BASE_URL=http://localhost:3000
```

This is already the default in `.env.example`.
No Entra or AWS credentials are needed for a mocked local session.

## Production and CI

- Secrets such as `ONEDRIVE_CLIENT_SECRET` and AWS credentials must not be stored in `.env` files in production.
- In AWS Lambda, set environment variables through Lambda configuration or AWS Secrets Manager.
- In CI, inject secrets through GitHub Actions secrets rather than committed files.
- The `.env` file is ignored by `.gitignore` and must never be committed.

## Validation

Each package that reads environment variables should validate them at startup and fail with a clear, actionable error if a required variable is missing or malformed.
Do not let unvalidated or missing configuration silently affect runtime behavior.
