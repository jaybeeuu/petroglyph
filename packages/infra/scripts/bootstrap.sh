#!/usr/bin/env bash
# Bootstrap Petroglyph AWS prerequisites for Terraform.
#
# Creates (or verifies) the resources that must exist *before* Terraform can
# manage its own backend: the remote state S3 bucket, the DynamoDB lock table,
# and the Lambda artifact bucket (including a placeholder zip so the first
# terraform apply has a valid object to reference).
#
# This script does NOT run terraform.  After running bootstrap, use
# `pnpm tf:apply` (or `./scripts/tf-apply.sh`) to initialise Terraform and
# provision application infrastructure.
#
# All operations are idempotent — safe to re-run.
#
# Usage:
#   ./bootstrap.sh [--profile <aws-profile>]
#
# Defaults:
#   --profile    petroglyph-admin

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────

PROFILE="petroglyph-admin"
REGION="eu-west-2"

# ── Argument parsing ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)   PROFILE="$2";   shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

AWS="aws --profile $PROFILE --region $REGION"
export AWS_PAGER=""

# ── Helpers ───────────────────────────────────────────────────────────────────

info()    { echo "▶  $*"; }
success() { echo "✓  $*"; }
fail()    { echo "✗  $*" >&2; exit 1; }

# ── Step 1: Verify credentials ────────────────────────────────────────────────

info "Verifying AWS credentials (profile: $PROFILE)..."
ACCOUNT_ID=$($AWS sts get-caller-identity --query Account --output text 2>/dev/null) \
  || fail "Cannot authenticate with profile '$PROFILE'. Run: aws sso login --profile $PROFILE"
success "Authenticated — account $ACCOUNT_ID"

# Derived names
TF_STATE_BUCKET="petroglyph-terraform-state-${ACCOUNT_ID}"
LAMBDA_ARTIFACT_BUCKET="petroglyph-lambda-artifacts-${ACCOUNT_ID}"
DYNAMODB_LOCK_TABLE="petroglyph-terraform-locks"
TF_STATE_KEY="petroglyph/terraform.tfstate"

# ── Step 2: Bootstrap S3 state bucket ────────────────────────────────────────

info "Checking Terraform state bucket ($TF_STATE_BUCKET)..."
if $AWS s3api head-bucket --bucket "$TF_STATE_BUCKET" 2>/dev/null; then
  success "State bucket already exists"
else
  info "Creating state bucket..."
  $AWS s3api create-bucket \
    --bucket "$TF_STATE_BUCKET" \
    --create-bucket-configuration LocationConstraint="$REGION"

  $AWS s3api put-bucket-versioning \
    --bucket "$TF_STATE_BUCKET" \
    --versioning-configuration Status=Enabled

  $AWS s3api put-public-access-block \
    --bucket "$TF_STATE_BUCKET" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

  $AWS s3api put-bucket-encryption \
    --bucket "$TF_STATE_BUCKET" \
    --server-side-encryption-configuration \
      '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

  success "State bucket created"
fi

# ── Step 3: Bootstrap DynamoDB lock table ─────────────────────────────────────

info "Checking DynamoDB lock table ($DYNAMODB_LOCK_TABLE)..."
if $AWS dynamodb describe-table --table-name "$DYNAMODB_LOCK_TABLE" &>/dev/null; then
  success "Lock table already exists"
else
  info "Creating lock table..."
  $AWS dynamodb create-table \
    --table-name "$DYNAMODB_LOCK_TABLE" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
  success "Lock table created"
fi

# ── Step 4: Bootstrap Lambda artifact bucket ──────────────────────────────────

info "Checking Lambda artifact bucket ($LAMBDA_ARTIFACT_BUCKET)..."
if $AWS s3api head-bucket --bucket "$LAMBDA_ARTIFACT_BUCKET" 2>/dev/null; then
  success "Lambda artifact bucket already exists"
else
  info "Creating Lambda artifact bucket..."
  $AWS s3api create-bucket \
    --bucket "$LAMBDA_ARTIFACT_BUCKET" \
    --create-bucket-configuration LocationConstraint="$REGION"

  $AWS s3api put-public-access-block \
    --bucket "$LAMBDA_ARTIFACT_BUCKET" \
    --public-access-block-configuration \
      BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

  success "Lambda artifact bucket created"
fi

# ── Step 5: Upload placeholder Lambda zip ────────────────────────────────────

PLACEHOLDER_KEY="placeholder/lambda.zip"

info "Checking for placeholder Lambda zip in $LAMBDA_ARTIFACT_BUCKET..."
if $AWS s3api head-object --bucket "$LAMBDA_ARTIFACT_BUCKET" --key "$PLACEHOLDER_KEY" &>/dev/null; then
  success "Placeholder zip already exists"
else
  info "Creating and uploading minimal placeholder Lambda zip..."
  TMPDIR=$(mktemp -d)
  cat > "$TMPDIR/index.js" << 'EOF'
exports.handler = async () => ({ statusCode: 200, body: '{"status":"placeholder"}' });
EOF
  python3 -c "
import zipfile, os
with zipfile.ZipFile('$TMPDIR/lambda.zip', 'w') as z:
    z.write('$TMPDIR/index.js', 'index.js')
"
  $AWS s3 cp "$TMPDIR/lambda.zip" "s3://$LAMBDA_ARTIFACT_BUCKET/$PLACEHOLDER_KEY"
  rm -rf "$TMPDIR"
  success "Placeholder zip uploaded"
fi

# ── Step 6: GitHub Actions deploy role ───────────────────────────────────────
#
# This role is assumed by GitHub Actions via OIDC. It is not managed by
# Terraform (to avoid a chicken-and-egg problem where Terraform needs the role
# to run). It must be created once via this script.

GITHUB_ACTIONS_ROLE="petroglyph-github-actions-deploy-production"
DEPLOY_POLICY_NAME="petroglyph-github-actions-deploy-production"

info "Checking GitHub OIDC provider..."
OIDC_PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
if $AWS iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_PROVIDER_ARN" &>/dev/null; then
  success "GitHub OIDC provider already exists"
else
  info "Creating GitHub OIDC provider..."
  $AWS iam create-open-id-connect-provider \
    --url "https://token.actions.githubusercontent.com" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1"
  success "GitHub OIDC provider created"
fi

info "Checking deploy role ($GITHUB_ACTIONS_ROLE)..."
if $AWS iam get-role --role-name "$GITHUB_ACTIONS_ROLE" &>/dev/null; then
  success "Deploy role already exists"
else
  info "Creating deploy role..."
  $AWS iam create-role \
    --role-name "$GITHUB_ACTIONS_ROLE" \
    --assume-role-policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [{
        \"Effect\": \"Allow\",
        \"Principal\": {
          \"Federated\": \"${OIDC_PROVIDER_ARN}\"
        },
        \"Action\": \"sts:AssumeRoleWithWebIdentity\",
        \"Condition\": {
          \"StringEquals\": {
            \"token.actions.githubusercontent.com:sub\": \"repo:jaybeeuu/petroglyph:environment:production\",
            \"token.actions.githubusercontent.com:aud\": \"sts.amazonaws.com\"
          }
        }
      }]
    }"
  success "Deploy role created"
fi

info "Checking deploy managed policy ($DEPLOY_POLICY_NAME)..."
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${DEPLOY_POLICY_NAME}"
POLICY_DOC=$(cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AcmCertificates",
      "Effect": "Allow",
      "Action": [
        "acm:RequestCertificate",
        "acm:DescribeCertificate",
        "acm:DeleteCertificate",
        "acm:ListCertificates",
        "acm:AddTagsToCertificate",
        "acm:ListTagsForCertificate",
        "acm:GetCertificate"
      ],
      "Resource": "*"
    },
    {
      "Sid": "IdentityCheck",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "TerraformStateAndArtifactsBuckets",
      "Effect": "Allow",
      "Action": [
        "s3:ListBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketVersioning",
        "s3:GetBucketTagging",
        "s3:PutBucketTagging",
        "s3:GetEncryptionConfiguration",
        "s3:PutEncryptionConfiguration",
        "s3:GetLifecycleConfiguration",
        "s3:PutLifecycleConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::petroglyph-terraform-state-${ACCOUNT_ID}",
        "arn:aws:s3:::petroglyph-lambda-artifacts-${ACCOUNT_ID}",
        "arn:aws:s3:::petroglyph-staged-pdfs-production"
      ]
    },
    {
      "Sid": "TerraformStateAndArtifactsObjects",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:AbortMultipartUpload",
        "s3:ListMultipartUploadParts"
      ],
      "Resource": [
        "arn:aws:s3:::petroglyph-terraform-state-${ACCOUNT_ID}/*",
        "arn:aws:s3:::petroglyph-lambda-artifacts-${ACCOUNT_ID}/*",
        "arn:aws:s3:::petroglyph-staged-pdfs-production/*"
      ]
    },
    {
      "Sid": "DynamoDbProjectTables",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:DescribeTable",
        "dynamodb:CreateTable",
        "dynamodb:UpdateTable",
        "dynamodb:DeleteTable",
        "dynamodb:TagResource",
        "dynamodb:UntagResource"
      ],
      "Resource": [
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-terraform-locks",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-users-production",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-refresh-tokens-production",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-sync-profiles-production",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-file-records-production"
      ]
    },
    {
      "Sid": "DynamoDbListTables",
      "Effect": "Allow",
      "Action": "dynamodb:ListTables",
      "Resource": "*"
    },
    {
      "Sid": "LambdaProjectFunctions",
      "Effect": "Allow",
      "Action": [
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:GetFunctionCodeSigningConfig",
        "lambda:ListVersionsByFunction",
        "lambda:CreateFunction",
        "lambda:UpdateFunctionCode",
        "lambda:UpdateFunctionConfiguration",
        "lambda:DeleteFunction",
        "lambda:AddPermission",
        "lambda:RemovePermission",
        "lambda:GetPolicy",
        "lambda:GetFunctionUrlConfig",
        "lambda:CreateFunctionUrlConfig",
        "lambda:UpdateFunctionUrlConfig",
        "lambda:DeleteFunctionUrlConfig",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:ListTags"
      ],
      "Resource": "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-*"
    },
    {
      "Sid": "ManageProjectRoles",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole",
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:TagRole",
        "iam:UntagRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:ListAttachedRolePolicies",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/petroglyph-*"
    },
    {
      "Sid": "ApiGatewayV2ForProject",
      "Effect": "Allow",
      "Action": [
        "apigateway:GET",
        "apigateway:POST",
        "apigateway:PUT",
        "apigateway:PATCH",
        "apigateway:DELETE"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ProjectLogGroups",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:DeleteLogGroup",
        "logs:PutRetentionPolicy",
        "logs:TagResource",
        "logs:UntagResource",
        "logs:DescribeLogGroups",
        "logs:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "ProjectQueues",
      "Effect": "Allow",
      "Action": [
        "sqs:CreateQueue",
        "sqs:DeleteQueue",
        "sqs:GetQueueAttributes",
        "sqs:SetQueueAttributes",
        "sqs:TagQueue",
        "sqs:UntagQueue",
        "sqs:ListQueueTags"
      ],
      "Resource": "arn:aws:sqs:eu-west-2:${ACCOUNT_ID}:petroglyph-*"
    },
    {
      "Sid": "ProjectSsmParameters",
      "Effect": "Allow",
      "Action": [
        "ssm:DescribeParameters",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
        "ssm:AddTagsToResource",
        "ssm:RemoveTagsFromResource",
        "ssm:ListTagsForResource"
      ],
      "Resource": [
        "arn:aws:ssm:eu-west-2:${ACCOUNT_ID}:parameter/petroglyph/*",
        "*"
      ]
    },
    {
      "Sid": "ProjectCloudWatchAlarms",
      "Effect": "Allow",
      "Action": [
        "cloudwatch:PutMetricAlarm",
        "cloudwatch:DeleteAlarms",
        "cloudwatch:DescribeAlarms",
        "cloudwatch:TagResource",
        "cloudwatch:UntagResource",
        "cloudwatch:ListTagsForResource"
      ],
      "Resource": "*"
    }
  ]
}
EOF
)

if $AWS iam get-policy --policy-arn "$POLICY_ARN" &>/dev/null; then
  success "Deploy managed policy already exists"
else
  info "Creating deploy managed policy..."
  $AWS iam create-policy \
    --policy-name "$DEPLOY_POLICY_NAME" \
    --policy-document "$POLICY_DOC"
  success "Deploy managed policy created"
fi

info "Checking managed policy is attached to role..."
if $AWS iam list-attached-role-policies --role-name "$GITHUB_ACTIONS_ROLE" \
    --query "AttachedPolicies[?PolicyArn=='${POLICY_ARN}']" --output text | grep -q .; then
  success "Managed policy already attached"
else
  info "Attaching managed policy to role..."
  $AWS iam attach-role-policy \
    --role-name "$GITHUB_ACTIONS_ROLE" \
    --policy-arn "$POLICY_ARN"
  success "Managed policy attached"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Bootstrap complete."
echo ""
echo "  TF_STATE_BUCKET        = $TF_STATE_BUCKET"
echo "  LAMBDA_ARTIFACT_BUCKET = $LAMBDA_ARTIFACT_BUCKET"
echo "  DEPLOY_ROLE_ARN        = arn:aws:iam::${ACCOUNT_ID}:role/${GITHUB_ACTIONS_ROLE}"
echo ""
echo "  Set these GitHub Actions secrets:"
echo "    AWS_ROLE_ARN           = arn:aws:iam::${ACCOUNT_ID}:role/${GITHUB_ACTIONS_ROLE}"
echo "    TF_STATE_BUCKET        = $TF_STATE_BUCKET"
echo "    LAMBDA_ARTIFACT_BUCKET = $LAMBDA_ARTIFACT_BUCKET"
echo ""
echo "  Local AWS profiles use IAM Identity Center (SSO)."
echo "  Run 'aws sso login --profile petroglyph-admin' to authenticate."
echo ""
echo "  Add to ~/.aws/config:"
echo "    [sso-session petroglyph]"
echo "    sso_start_url          = https://d-9c674d4043.awsapps.com/start"
echo "    sso_region             = $REGION"
echo "    sso_registration_scopes = sso:account:access"
echo ""
echo "    [profile petroglyph-admin]"
echo "    sso_session            = petroglyph"
echo "    sso_account_id         = $ACCOUNT_ID"
echo "    sso_role_name          = AdministratorAccess"
echo "    region                 = $REGION"
echo ""
echo "    [profile petroglyph-readonly]"
echo "    sso_session            = petroglyph"
echo "    sso_account_id         = $ACCOUNT_ID"
echo "    sso_role_name          = petroglyph-readonly"
echo "    region                 = $REGION"
echo ""
echo "  Use petroglyph-readonly for day-to-day work."
echo "  Use petroglyph-admin only for terraform apply."
echo ""
echo "  Next step: pnpm tf:apply --profile $PROFILE"
echo "════════════════════════════════════════════════════════════════"
