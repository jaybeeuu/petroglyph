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

| Profile            | Permission set       | Use                      |
| ------------------ | -------------------- | ------------------------ |
| `petroglyph-admin` | AdministratorAccess  | All Terraform + AWS work |

### First-time CLI setup

If setting up on a new machine:

```sh
aws configure sso
```

| Prompt                   | Value                                                              |
| ------------------------ | ------------------------------------------------------------------ |
| SSO session name         | `petroglyph`                                                       |
| SSO start URL            | Obtain from IAM Identity Center → Dashboard in the AWS console     |
| SSO region               | `eu-west-2`                                                        |
| SSO registration scopes  | (press Enter for default)                                          |
| CLI default region       | `eu-west-2`                                                        |
| CLI default output format| `json`                                                             |
| CLI profile name         | `petroglyph-admin`                                                 |

---

## Deployment Prerequisites

Before running `terraform apply` for the first time, the bootstrap resources must be created. Run the bootstrap script from `packages/infra/`:

```sh
./scripts/bootstrap.sh --profile petroglyph-admin
```

This creates and verifies the following (bucket names embed your AWS account ID to guarantee global S3 uniqueness):

| Resource                  | Name pattern                                      | Purpose                        |
| ------------------------- | ------------------------------------------------- | ------------------------------ |
| S3 bucket                 | `petroglyph-terraform-state-<ACCOUNT_ID>`         | Terraform remote state storage |
| DynamoDB table            | `petroglyph-terraform-locks`                      | Terraform state locking        |
| S3 bucket                 | `petroglyph-lambda-artifacts-<ACCOUNT_ID>`        | Lambda deployment ZIP artifacts|

Once applied, the following values are needed as GitHub Actions secrets on the `production` environment for CD:

| Secret                   | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `AWS_ROLE_ARN`           | ARN of the IAM role assumed via OIDC for deployments  |
| `TF_STATE_BUCKET`        | `petroglyph-terraform-state-<ACCOUNT_ID>`             |
| `LAMBDA_ARTIFACT_BUCKET` | `petroglyph-lambda-artifacts-<ACCOUNT_ID>`            |

Configure the `production` environment so only `main` can deploy, and require deployment review before the `deploy` job proceeds. See [CONTRIBUTING.md](../CONTRIBUTING.md#cd-secrets) for how to configure these secrets.
