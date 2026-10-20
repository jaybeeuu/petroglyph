# Operations

This document covers maintainer-only concerns: AWS account structure, developer authentication, and deployment prerequisites. It is not required reading for contributors who only need to run the project locally.

---

## AWS Account Structure

Petroglyph runs in a dedicated AWS account under an AWS Organization. The organization management account is used only for billing and org admin — no Petroglyph resources are deployed there.

```
AWS Organization (management account)
└── petroglyph   ← all Petroglyph resources live here
```

This gives clean billing isolation and limits the blast radius of any infrastructure mistake to the Petroglyph account.

## AWS Authentication

Access is via **AWS IAM Identity Center** (SSO), hosted in `eu-west-2`. There are no long-lived IAM user access keys.

To authenticate from a terminal:

```sh
aws sso login --profile petroglyph-admin
```

The SSO session is valid for 8 hours. After it expires, run the command again.

To verify authentication:

```sh
aws sts get-caller-identity --profile petroglyph-admin
```

Expected output:

```json
{
  "UserId": "...",
  "Account": "<ACCOUNT_ID>",
  "Arn": "arn:aws:sts::<ACCOUNT_ID>:assumed-role/AWSReservedSSO_AdministratorAccess_.../..."
}
```

### Profile reference

| Profile            | Permission set      | Use                      |
| ------------------ | ------------------- | ------------------------ |
| `petroglyph-admin` | AdministratorAccess | All Terraform + AWS work |

### First-time CLI setup

If setting up on a new machine:

```sh
aws configure sso
```

| Prompt                    | Value                                                          |
| ------------------------- | -------------------------------------------------------------- |
| SSO session name          | `petroglyph`                                                   |
| SSO start URL             | Obtain from IAM Identity Center → Dashboard in the AWS console |
| SSO region                | `eu-west-2`                                                    |
| SSO registration scopes   | (press Enter for default)                                      |
| CLI default region        | `eu-west-2`                                                    |
| CLI default output format | `json`                                                         |
| CLI profile name          | `petroglyph-admin`                                             |

---

## Deployment Prerequisites

Before running `terraform apply` for the first time, the bootstrap resources must be created. Run the bootstrap script from `packages/infra/`:

```sh
./scripts/bootstrap.sh --profile petroglyph-admin
```

This creates and verifies the following (bucket names embed your AWS account ID to guarantee global S3 uniqueness):

| Resource           | Name pattern                                               | Purpose                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S3 bucket          | `petroglyph-terraform-state-<ACCOUNT_ID>`                  | Terraform remote state storage                                                                                                                                     |
| DynamoDB table     | `petroglyph-terraform-locks`                               | Terraform state locking                                                                                                                                            |
| S3 bucket          | `petroglyph-lambda-artifacts-<ACCOUNT_ID>`                 | Lambda deployment ZIP artifacts                                                                                                                                    |
| IAM managed policy | `petroglyph-github-actions-deploy-<ENVIRONMENT>`           | Deploy permissions (platform half), one policy per environment; bootstrap.sh converges each to the checked-in document on drift                                    |
| IAM managed policy | `petroglyph-github-actions-deploy-<ENVIRONMENT>-workloads` | Deploy permissions (DynamoDB tables, Lambda functions, SQS queues and their event-source mappings); split out because IAM caps a managed policy at 6144 characters |
| IAM role           | `petroglyph-github-actions-deploy-<ENVIRONMENT>`           | OIDC deploy role for the `production` and `qa` GitHub environments                                                                                                 |
| IAM role           | `petroglyph-github-actions-plan`                           | Read-only role assumed by the PR-time terraform plan workflow                                                                                                      |

### Environments

The stack runs in two persistent Terraform workspaces on the same S3 backend key (`petroglyph/terraform.tfstate`; workspaces namespace the state under `env:/<workspace>/…`):

| Environment  | Terraform workspace | GitHub environment | Custom domain           | Purpose                                                      |
| ------------ | ------------------- | ------------------ | ----------------------- | ------------------------------------------------------------ |
| `production` | `production`        | `production`       | `api.petroglyph.page`   | The live tier. Main-only; the PR merge is the deploy gate.   |
| `qa`         | `qa`                | `qa`               | (raw `execute-api` URL) | The deployed-smoke tier; carries the Graph stub in `up9y.4`. |

`.github/workflows/deploy.yml` runs both deploy jobs from the shared build/package artifacts. Each job takes its GitHub environment, Terraform workspace and `api_custom_domain` from job-level values, so the production job is unchanged and the QA job deploys its own workspace. The job creates the workspace if it does not exist (`terraform workspace select qa || terraform workspace new qa`).

The QA tier's resources are provisioned once by an admin, exactly as production was: the deploy role's managed policy manages existing staged/serving resources but does not grant bucket creation, so a first-time apply runs as `petroglyph-admin` (`./scripts/tf-apply.sh --workspace qa`). After that the `deploy-qa` job maintains the tier on each merge.

### SSM parameter namespacing

Every SSM parameter is namespaced by Terraform workspace: `/petroglyph/<workspace>/<category>/<leaf>`. Before the QA tier the parameters were global (`/petroglyph/<category>/<leaf>`), which two workspaces would fight over. The Lambda roles' `ssm:GetParameter` grants and `*_SSM_PATH` environment variables follow the workspace automatically. Production also has the values migrated once (see [SSM parameter migration](#ssm-parameter-migration-one-time)).

### Guardrails

- **Granular policy**: the deploy managed policies (`petroglyph-github-actions-deploy-production` and its `-workloads` sibling) are explicit-actions-only. Never add `"Action": "*"`, and name the ARN of every project resource by hand in `packages/infra/scripts/bootstrap.sh` (e.g. `DynamoDbProjectTables`, `LambdaProjectFunctions`, `ProjectQueues`). Statements whose actions cannot be resource-scoped (for example `dynamodb:ListTables`, `logs:DescribeLogGroups`) use `"Resource": "*"`, which is unavoidable. The authored permission set exceeds IAM's 6144-character managed-policy limit, so `bootstrap.sh` splits it across the two policies by SID (`WORKLOAD_SIDS`); a new statement lands on the platform policy unless its SID is added there.
- **Event-source-mapping ARNs are mostly scoped, with two unscopable actions**: `LambdaProjectFunctions` and `ProjectQueues` name each function and queue ARN explicitly. `LambdaEventSourceMappings` scopes to `arn:aws:lambda:eu-west-2:<ACCOUNT_ID>:event-source-mapping:*` for `DeleteEventSourceMapping`, `GetEventSourceMapping`, `ListTags`, `TagResource`, `UntagResource` and `UpdateEventSourceMapping`. The Lambda API does not support resource-level permissions for `CreateEventSourceMapping` or `ListEventSourceMappings`, so those two actions live in the separate `LambdaEventSourceMappingUnscopable` statement under `"Resource": "*"`. Revisit it if AWS adds a resource-level or tag condition for create.
- **Resource additions extend bootstrap.sh in the same change**: any work adding an AWS resource under `packages/infra/*.tf` must add the required ARNs/actions to `bootstrap.sh` in the same commit.
- **Single source of truth**: `bootstrap.sh` is the source of truth for the deploy policy; the live policy converges to the checked-in document via the node drift-check (commit 4a888fb). Re-run `bootstrap.sh` after any policy change.
- **Terraform checks run at PR time**: `.github/workflows/terraform.yml` runs on pull requests that touch `packages/infra/**/*.tf` and performs `terraform fmt -check`, `terraform init`, `terraform validate` and a read-only `terraform plan -refresh=false -lock=false -detailed-exitcode` with the same `-var` set as the CD apply (non-empty artifact bucket, placeholder keys). The plan diff is posted to the PR as a collapsed comment that is updated in place. The job fails only when the plan itself errors — exit code 2 (changes present) is the normal outcome for an infra PR. Formatting drift in files the PR does not touch is reported as a warning rather than a failure, so pre-existing drift does not block unrelated changes.
- **Plan role is read-only**: the PR job assumes `petroglyph-github-actions-plan`, trusted for `repo:jaybeeuu/petroglyph:environment:terraform-plan`. Its permissions are read-only: the Terraform state bucket (`s3:GetObject`, `s3:ListBucket`), `ssm:GetParameter` on `/petroglyph/production/onedrive/client-id` with the matching `kms:Decrypt` scoped to `ssm.eu-west-2.amazonaws.com`, and `dynamodb:DescribeTable` on `table/petroglyph-*`. Those reads are forced by Terraform's plan phase even with `-refresh=false`: data sources are always read (`data.aws_ssm_parameter.onedrive_client_id` feeds two Lambda env vars), and the AWS provider's `aws_dynamodb_table` runs `validateTableAttributes` in `CustomizeDiff`, which calls `DescribeTable` for every table resource. No write or data-plane action is granted, so a pull request can never create, update or delete infrastructure, and it cannot assume the production deploy role. Because it holds no write permissions, the PR plan does not replace review: a dropped DLQ alarm or a widened IAM statement still plans cleanly.
- **PR plan skips without credentials**: fork PRs and PRs raised before the `terraform-plan` environment is configured have no plan secrets, so the job skips cleanly instead of failing.

Once applied, the following values are needed as GitHub Actions secrets on **each** deploy environment for CD. `production` and `qa` hold their own `AWS_ROLE_ARN` (each deploy job declares its environment, so the secret resolves per environment); the bucket names are shared.

| Secret                   | Description                                        |
| ------------------------ | -------------------------------------------------- |
| `AWS_ROLE_ARN`           | ARN of the environment's IAM role assumed via OIDC |
| `TF_STATE_BUCKET`        | `petroglyph-terraform-state-<ACCOUNT_ID>`          |
| `LAMBDA_ARTIFACT_BUCKET` | `petroglyph-lambda-artifacts-<ACCOUNT_ID>`         |

Configure the `production` environment so only `main` can deploy, and create a `qa` environment with the same secrets but `AWS_ROLE_ARN = arn:aws:iam::<ACCOUNT_ID>:role/petroglyph-github-actions-deploy-qa`. There is no separate deployment-review gate on the `production` environment: merging a PR to `main` deploys immediately, so **the PR review and merge is the deployment gate** — review the `.tf` diff knowing it will apply on merge. See [CONTRIBUTING.md](../CONTRIBUTING.md#cd-secrets) for how to configure these secrets.

### SSM parameter migration (one-time)

`aws_ssm_parameter.name` is `ForceNew`, so the namespace rename _replaces_ every parameter — destroying the hand-entered SecureString values. Run the one-time migration as `petroglyph-admin` before the first deploy that carries the namespaced `ssm.tf`:

```sh
cd packages/infra
./scripts/migrate-ssm-namespace.sh --profile petroglyph-admin --workspace production
```

The script snapshots every legacy parameter (names, values and types) to a `chmod 600` JSON file under `packages/infra/`, applies the rename with `terraform apply -target` scoped to the `aws_ssm_parameter` resources, then writes the values back to `/petroglyph/production/…`. Verify the namespaced parameters, then delete the snapshot. The snapshot is the rollback artefact: the migration never re-keys a secret by hand, and re-running it is a no-op once nothing legacy remains.

PR-time plans read their credentials from a separate `terraform-plan` environment. It must have **no branch restriction** (the job runs on pull requests from any branch) and hold the same state/artifact bucket names plus the read-only role ARN:

| Secret                   | Description                                    |
| ------------------------ | ---------------------------------------------- |
| `AWS_PLAN_ROLE_ARN`      | ARN of the read-only IAM role assumed via OIDC |
| `TF_STATE_BUCKET`        | `petroglyph-terraform-state-<ACCOUNT_ID>`      |
| `LAMBDA_ARTIFACT_BUCKET` | `petroglyph-lambda-artifacts-<ACCOUNT_ID>`     |

Until `AWS_PLAN_ROLE_ARN` is set, the terraform plan job skips cleanly rather than failing. Creating the environment (and running `bootstrap.sh` to create `petroglyph-github-actions-plan`) is a manual step.

---

## Lambda Packaging (ESM)

Petroglyph Lambdas are deployed from zipped artifacts stored in S3. Any Lambda package must include its runtime dependencies in the zip — bare `node_modules` are **not** deployed.

- **Bundled Lambdas (ESM)**: The API, ingest-onedrive, sync-worker, sync-relay, processor, staging-consumer (staging forwarder + dispatch) and staging-delivery Lambdas are bundled with esbuild to **ESM** output so runtime dependencies (for example `zod`) are included. The ingest-onedrive zip carries **two esbuild entries** — the webhook receiver (`dist/index.handler`) and the OneDrive adapter (`dist/lambda.handler`) — from a single `pnpm package` run. The staging-consumer zip likewise carries **two esbuild entries** — the forwarder (`dist/lambda.handler`) and the dispatch consumer (`dist/dispatch-lambda.handler`).
- **Non-Lambda packages (ESM)**: Keep these as bare **ESM** modules to preserve tree-shaking. Do not emit CommonJS builds.
- **Packaging entrypoint**: `pnpm package` runs each package’s `package` script (via `--if-present`) before deploy.

When adding a new Lambda:

1. Add a `package` script that produces `lambda.zip` (bundled ESM).
2. Ensure the deploy workflow uploads the new zip and passes its S3 key to Terraform.

---

## Third-party App Registration

Terraform creates SSM parameters with `value = "PLACEHOLDER"` on first apply (with `lifecycle { ignore_changes = [value] }` so CD never overwrites real values). After bootstrapping, the real credentials must be stored manually using the steps below.

`ignore_changes` protects in-place updates only: `aws_ssm_parameter.name` is `ForceNew`, so a rename or other forced replacement recreates the parameter as `PLACEHOLDER` without failing the apply. Verify values after any apply that replaces parameters — see [Secret lifecycle and re-keying](#secret-lifecycle-and-re-keying).

### GitHub OAuth App

Used for user login (`GET /auth/url` → `GET /auth/callback`).

1. Go to **github.com → Settings → Developer settings → OAuth Apps → New OAuth App**.
2. Fill in:
   | Field | Value |
   |---|---|
   | Application name | `petroglyph` |
   | Homepage URL | `https://api.petroglyph.page` |
   | Authorization callback URL | `https://api.petroglyph.page/auth/callback` |
3. Click **Register application**, then **Generate a new client secret**.
4. Copy the **Client ID** and **Client secret**.
5. Store in SSM (overwrite the placeholder):

   ```sh
   aws ssm put-parameter --profile petroglyph-admin \
     --name /petroglyph/production/github/client-id \
     --value "<client-id>" --type SecureString --overwrite

   aws ssm put-parameter --profile petroglyph-admin \
     --name /petroglyph/production/github/client-secret \
     --value "<client-secret>" --type SecureString --overwrite
   ```

6. Force a Lambda cold start to pick up the new values:

   ```sh
   aws lambda update-function-configuration --profile petroglyph-admin \
     --function-name petroglyph-api-production \
     --description "force cold start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
   ```

   The API reads `github/*` from SSM at cold start, so this is enough for sign-in.
   `MICROSOFT_CLIENT_ID` is different — it is baked at deploy time (see step 7 below).

### Microsoft Entra ID App (OneDrive)

Used for OneDrive connection (`GET /onedrive/auth-url` → `GET /onedrive/connect`).

1. Go to [portal.azure.com](https://portal.azure.com) → search **App registrations** → **New registration**.
2. Fill in:
   | Field | Value |
   |---|---|
   | Name | `petroglyph` |
   | Supported account types | **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)** |
   | Redirect URI platform | **Web** |
   | Redirect URI | `https://api.petroglyph.page/onedrive/connect` |

   > **⚠ Important — Supported account types**: The value above must be selected exactly. If you choose a single-tenant or organisation-only option, personal Microsoft account holders will receive an `unauthorized_client: The client does not exist or is not enabled for consumers` error when attempting to connect OneDrive.

3. Click **Register**. Copy the **Application (client) ID** from the overview page.
4. Go to **API permissions → Add a permission → Microsoft Graph → Delegated permissions**. Add:
   - `Files.ReadWrite`
   - `offline_access`
5. Go to **Certificates & secrets → New client secret**. Copy the **Value** immediately (it is only shown once).
6. Store in SSM (overwrite the placeholder):

   ```sh
   aws ssm put-parameter --profile petroglyph-admin \
     --name /petroglyph/production/onedrive/client-id \
     --value "<application-client-id>" --type SecureString --overwrite

   aws ssm put-parameter --profile petroglyph-admin \
     --name /petroglyph/production/onedrive/client-secret \
     --value "<client-secret-value>" --type SecureString --overwrite
   ```

7. Cold start the API and **redeploy** the baked-env Lambdas. `onedrive/client-secret` is read
   from SSM at cold start, but `MICROSOFT_CLIENT_ID` is baked into `ingest-onedrive` and
   `sync-worker` at deploy time:

   ```sh
   aws lambda update-function-configuration --profile petroglyph-admin \
     --function-name petroglyph-api-production \
     --description "force cold start $(date -u +%Y-%m-%dT%H:%M:%SZ)"

   gh workflow run deploy.yml --ref main
   ```

   A cold start alone leaves `MICROSOFT_CLIENT_ID` at its old value.

### Secret lifecycle and re-keying

The seven live production parameters are hand-managed; Terraform never owns their values.

| SSM path (`/petroglyph/production/…`) | Read by                                                        | How to re-key                                                                 |
| ------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `github/client-id`                    | api (SSM, cold start)                                          | GitHub OAuth App settings — stable                                            |
| `github/client-secret`                | api (SSM, cold start)                                          | GitHub OAuth App → Generate a new client secret                               |
| `jwt/signing-secret`                  | api (SSM, cold start)                                          | `openssl rand -base64 48`                                                     |
| `jwt/private-key`                     | api (SSM, cold start)                                          | `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048` (PKCS#8 PEM)   |
| `jwt/public-key`                      | api + staging (SSM, cold start)                                | `openssl pkey -in private.pem -pubout` (SPKI PEM, must match the private key) |
| `onedrive/client-id`                  | api (SSM) + ingest-onedrive, sync-worker (**baked at deploy**) | Entra app registration overview — stable                                      |
| `onedrive/client-secret`              | api + staging (SSM, cold start)                                | Entra → Certificates & secrets → New client secret                            |

The remaining `/petroglyph/production/…` parameters — `onedrive/access-token`,
`onedrive/refresh-token`, `onedrive/token-expiry`, `graph/subscription-id`, `config/*` — are dead.
Per-connection OneDrive tokens live in the `token_vaults` DynamoDB table
(`packages/core/src/tokens/token-store.ts`). Do not re-key them; they are scheduled for removal.

**No password-manager copy is kept** (decision 2026-10-20). Every value above is regenerable from
its source system, so a backup would protect availability (time), not against irrecoverable loss.
The accepted trade-off: if SSM is wiped again, re-key from this table and redeploy. The durable
controls are this runbook and the post-apply check below — not secret duplication.

**Wipe hazard.** Because `name` is `ForceNew` and `value` is under `ignore_changes`, a rename or
forced replacement destroys the hand-entered value and recreates it as `PLACEHOLDER` **without the
apply failing**. This is the 2026-10-13 incident: the namespace migration replaced all 14
parameters before its restore step succeeded, and the next deploy recreated them from the `ssm.tf`
default. After any apply that replaces parameters, check for reverted values:

```sh
aws ssm get-parameters-by-path --profile petroglyph-admin \
  --path /petroglyph/production --recursive --with-decryption \
  --query 'Parameters[].[Name,Value]' --output text |
  awk -F'\t' '$2=="PLACEHOLDER" {print "STILL PLACEHOLDER:", $1}'
```

**Cold start vs redeploy.** `github/*` and `onedrive/*` are fetched from SSM at Lambda cold start,
so a cold start picks them up. `MICROSOFT_CLIENT_ID` is baked into the `ingest-onedrive` and
`sync-worker` environment at deploy time from `data.aws_ssm_parameter.onedrive_client_id`, so a
change to `onedrive/client-id` requires a redeploy.
