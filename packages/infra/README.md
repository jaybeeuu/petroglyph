# petroglyph/infra

Terraform configuration for the Petroglyph AWS infrastructure.

## Prerequisites

- Terraform >= 1.5
- AWS credentials with permissions to manage the resources defined here
- The bootstrap resources below must exist before running `terraform init`

## Bootstrap (first time only)

The S3 remote state backend and DynamoDB lock table must be created **once** before
Terraform can manage its own state. Because these resources bootstrap Terraform itself
they are created manually (or via the AWS CLI) rather than by this configuration.

### Create the state bucket

```bash
aws s3api create-bucket \
  --bucket petroglyph-terraform-state \
  --region eu-west-2 \
  --create-bucket-configuration LocationConstraint=eu-west-2

# Enable versioning so previous state files are recoverable
aws s3api put-bucket-versioning \
  --bucket petroglyph-terraform-state \
  --versioning-configuration Status=Enabled

# Block all public access
aws s3api put-public-access-block \
  --bucket petroglyph-terraform-state \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Enable default encryption
aws s3api put-bucket-encryption \
  --bucket petroglyph-terraform-state \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

### Create the DynamoDB lock table

```bash
aws dynamodb create-table \
  --table-name petroglyph-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region eu-west-2
```

## Initialise

After the bootstrap resources exist, initialise Terraform with the remote backend:

```bash
terraform init
```

## Workspace convention

Each deployment environment is a Terraform workspace. Workspace names are embedded
into every resource name and tag so that staging and production are fully isolated
within the same AWS account.

```bash
# Create workspaces (first time only)
terraform workspace new staging
terraform workspace new production

# Switch between environments
terraform workspace select staging
terraform workspace select production

# Confirm the current workspace
terraform workspace show
```

Resource names follow the pattern `petroglyph-<resource>-<workspace>`, e.g.:

| Workspace    | S3 bucket                          |
|--------------|------------------------------------|
| `staging`    | `petroglyph-staged-pdfs-staging`   |
| `production` | `petroglyph-staged-pdfs-production`|

All resources also carry an `environment` tag set to `terraform.workspace`.

## Plan and apply

```bash
terraform workspace select staging
terraform plan
terraform apply
```

> **Note:** The S3 backend `key` is a fixed path (`petroglyph/terraform.tfstate`).
> Terraform automatically namespaces state files per workspace under
> `env:/<workspace>/petroglyph/terraform.tfstate` (for non-default workspaces),
> so each workspace has its own isolated state file in the same bucket.
