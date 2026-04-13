# petroglyph/infra

Terraform configuration for the Petroglyph AWS infrastructure.

## How the workflow is structured

Setting up infrastructure for the first time involves two distinct steps:

1. **Bootstrap** — create the AWS resources that Terraform itself depends on
   (the remote state bucket, lock table, and Lambda artifact bucket). This
   step uses plain AWS CLI calls and does _not_ invoke Terraform.

2. **Apply** — run `terraform init`, select a workspace, plan, and apply the
   application infrastructure. This step is safe to repeat; a destroy guard
   prevents accidental deletions.

Both steps are exposed as `pnpm` scripts in this package.

---

## Prerequisites

Before running anything:

- **Terraform** >= 1.5 installed and on your `$PATH`
- **AWS CLI** installed and on your `$PATH`
- **AWS SSO login** for a profile with permission to create IAM roles, S3
  buckets, DynamoDB tables, Lambda functions, and API Gateway resources

Log in to AWS SSO before proceeding:

```bash
aws sso login --profile petroglyph-admin
```

---

## Step 1: Bootstrap (first time only)

Bootstrap creates the S3 remote state bucket, DynamoDB lock table, and Lambda
artifact bucket that Terraform needs before it can store its own state. It
also uploads a placeholder Lambda zip so the first `terraform apply` has a
valid S3 object to reference.

The script is idempotent — safe to re-run at any time.

```bash
pnpm bootstrap --profile petroglyph-admin
# or run the script directly:
./scripts/bootstrap.sh --profile petroglyph-admin
```

When it finishes it prints the bucket names you will need later:

```
TF_STATE_BUCKET        = petroglyph-terraform-state-<ACCOUNT_ID>
LAMBDA_ARTIFACT_BUCKET = petroglyph-lambda-artifacts-<ACCOUNT_ID>
```

S3 bucket names include the AWS account ID to guarantee global uniqueness.

---

## Step 2: Apply (provision application infrastructure)

After bootstrap succeeds, apply the Terraform configuration:

```bash
pnpm tf:apply --profile petroglyph-admin --workspace development
# or run the script directly:
./scripts/tf-apply.sh --profile petroglyph-admin --workspace development
```

The script:

1. Runs `terraform init` wired to the S3 backend and DynamoDB lock table
2. Selects (or creates) the target workspace
3. Runs `terraform plan` — aborts if any destroys are found
4. Runs `terraform apply`
5. Verifies that expected resources exist

To deploy a real Lambda artifact instead of the placeholder, pass the S3
location:

```bash
pnpm tf:apply \
  --profile petroglyph-admin \
  --workspace development \
  --api-zip-bucket petroglyph-lambda-artifacts-<ACCOUNT_ID> \
  --api-zip-key lambda-<sha>.zip
```

---

## Workspace convention

Each deployment environment is a Terraform workspace. Workspace names are
embedded into every resource name and tag so that environments are fully
isolated within the same AWS account.

```bash
# Create a workspace for the first time
./scripts/tf-apply.sh --profile petroglyph-admin --workspace development

# Switch between environments by passing --workspace
./scripts/tf-apply.sh --profile petroglyph-admin --workspace staging
./scripts/tf-apply.sh --profile petroglyph-admin --workspace production
```

Resource names follow the pattern `petroglyph-<resource>-<workspace>`, e.g.:

| Workspace     | S3 bucket                            |
| ------------- | ------------------------------------ |
| `development` | `petroglyph-staged-pdfs-development` |
| `staging`     | `petroglyph-staged-pdfs-staging`     |
| `production`  | `petroglyph-staged-pdfs-production`  |

All resources also carry an `environment` tag set to `terraform.workspace`.

> **Note:** The S3 backend `key` is a fixed path (`petroglyph/terraform.tfstate`).
> Terraform automatically namespaces state files per workspace under
> `env:/<workspace>/petroglyph/terraform.tfstate` (for non-default workspaces),
> so each workspace has its own isolated state file in the same bucket.

---

## Ingest SQS, DLQ, and Lambda Trigger

The ingest infrastructure provisions an SQS queue for webhook-driven ingestion, a dead-letter queue (DLQ) for failed jobs, and a CloudWatch alarm on DLQ depth. The processor Lambda is triggered by the SQS queue, with a visibility timeout set longer than the Lambda timeout to avoid duplicate processing. Failed jobs are sent to the DLQ, and the alarm triggers an SNS email notification. The processor Lambda environment is wired with `MICROSOFT_CLIENT_ID` and has tightly scoped SQS IAM permissions. Webhook route and output changes are reflected in the Terraform configuration.

---

## Troubleshooting

### Apply fails mid-run → tainted resource

If `terraform apply` fails partway through (e.g. a permissions error on one resource), Terraform marks the partially-created resource as **tainted**. The next `plan` will include a destroy-then-recreate for it, which will trip the destroy guard.

To recover, untaint the resource and re-run:

```bash
terraform untaint <resource_address>
# e.g.:
terraform untaint aws_lambda_function.petroglyph_api
pnpm tf:apply --profile petroglyph-admin --workspace development
```

### Lambda concurrency error on new accounts

New AWS accounts have a default regional Lambda concurrency limit of **10**. AWS requires at least 10 concurrency units to remain unreserved, so you cannot set `reserved_concurrent_executions` to 10 on a single function.

The config intentionally omits `reserved_concurrent_executions` for this reason. If you have requested a higher concurrency limit, you can add it back to `lambda_api.tf`.

### Manual bootstrap reference

If you need to create the bootstrap resources by hand without the script:

#### Create the state bucket

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile petroglyph-admin)

aws s3api create-bucket \
  --bucket petroglyph-terraform-state-${ACCOUNT_ID} \
  --region eu-west-2 \
  --create-bucket-configuration LocationConstraint=eu-west-2 \
  --profile petroglyph-admin

aws s3api put-bucket-versioning \
  --bucket petroglyph-terraform-state-${ACCOUNT_ID} \
  --versioning-configuration Status=Enabled \
  --profile petroglyph-admin

aws s3api put-public-access-block \
  --bucket petroglyph-terraform-state-${ACCOUNT_ID} \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
  --profile petroglyph-admin

aws s3api put-bucket-encryption \
  --bucket petroglyph-terraform-state-${ACCOUNT_ID} \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}' \
  --profile petroglyph-admin
```

#### Create the DynamoDB lock table

```bash
aws dynamodb create-table \
  --table-name petroglyph-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region eu-west-2 \
  --profile petroglyph-admin
```
