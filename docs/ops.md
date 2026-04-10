# Operations

This document covers maintainer-only concerns: AWS account structure, developer authentication, and deployment prerequisites. It is not required reading for contributors who only need to run the project locally.

---

## AWS Account Structure

Petroglyph runs in a dedicated AWS account (`<ACCOUNT_ID>`) under an AWS Organization. The organization management account is used only for billing and org admin — no Petroglyph resources are deployed there.

```
AWS Organization (management account)
└── petroglyph (<ACCOUNT_ID>)   ← all Petroglyph resources live here
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

| Profile            | Account      | Permission set       | Use                      |
| ------------------ | ------------ | -------------------- | ------------------------ |
| `petroglyph-admin` | <ACCOUNT_ID> | AdministratorAccess  | All Terraform + AWS work |

### First-time CLI setup

If setting up on a new machine:

```sh
aws configure sso
```

| Prompt                   | Value                                    |
| ------------------------ | ---------------------------------------- |
| SSO session name         | `petroglyph`                             |
| SSO start URL            | `Obtain from IAM Identity Center → Dashboard in the AWS console` |
| SSO region               | `eu-west-2`                              |
| SSO registration scopes  | (press Enter for default)                |
| CLI default region       | `eu-west-2`                              |
| CLI default output format| `json`                                   |
| CLI profile name         | `petroglyph-admin`                       |

---

## Deployment Prerequisites

Before running `terraform apply` for the first time, two resources must be created manually (they back the Terraform remote state and cannot be managed by Terraform itself):

| Resource                  | Name                                              | Purpose                        |
| ------------------------- | ------------------------------------------------- | ------------------------------ |
| S3 bucket                 | `petroglyph-terraform-state-<ACCOUNT_ID>`         | Terraform remote state storage |
| DynamoDB table            | `petroglyph-terraform-locks`                      | Terraform state locking        |

These are created and verified as part of **dv4.9.2**. See that bead for the exact commands.

Once applied, the following values are needed as GitHub Actions secrets for CD:

| Secret                   | Description                                           |
| ------------------------ | ----------------------------------------------------- |
| `AWS_ROLE_ARN`           | ARN of the IAM role assumed via OIDC for deployments  |
| `TF_STATE_BUCKET`        | `petroglyph-terraform-state-<ACCOUNT_ID>`             |
| `LAMBDA_ARTIFACT_BUCKET` | S3 bucket for Lambda deployment ZIP artifacts         |

See [CONTRIBUTING.md](../CONTRIBUTING.md#cd-secrets) for how to configure these secrets.
