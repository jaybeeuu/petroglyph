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

# Directory containing this script, so helper tools can be referenced
# regardless of the working directory the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
  node "$SCRIPT_DIR/make-zip.mjs" "$TMPDIR/index.js" "$TMPDIR/lambda.zip"
  $AWS s3 cp "$TMPDIR/lambda.zip" "s3://$LAMBDA_ARTIFACT_BUCKET/$PLACEHOLDER_KEY"
  rm -rf "$TMPDIR"
  success "Placeholder zip uploaded"
fi

# ── Step 6: GitHub Actions deploy roles ──────────────────────────────────────
#
# One deploy role per environment. Each is assumed by its own GitHub
# environment via OIDC and trusts only that environment's subject, so a QA job
# cannot assume the production deploy role. They are not managed by Terraform
# (to avoid a chicken-and-egg problem where Terraform needs the role to run);
# they must be created once via this script.

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

# Create, update, or verify one managed policy and attach it to the deploy
# role. IAM caps a managed policy document at 6144 characters, so the deploy
# permissions are split across two policies (see docs/ops.md); converging each
# independently means a future addition that overflows one is caught here.
converge_managed_policy() {
  local policy_name="$1"
  local policy_doc="$2"
  local policy_arn="arn:aws:iam::${ACCOUNT_ID}:policy/${policy_name}"

  info "Checking deploy managed policy ($policy_name)..."
  if $AWS iam get-policy --policy-arn "$policy_arn" &>/dev/null; then
    local default_version_id
    default_version_id=$($AWS iam get-policy \
      --policy-arn "$policy_arn" \
      --query 'Policy.DefaultVersionId' \
      --output text)

    local live_policy_doc
    live_policy_doc=$($AWS iam get-policy-version \
      --policy-arn "$policy_arn" \
      --version-id "$default_version_id" \
      --query 'PolicyVersion.Document' \
      --output json)

    # IAM may normalise whitespace and key order, so compare the documents
    # semantically (as parsed JSON) rather than as raw text.
    if ! node --input-type=commonjs -e '
const { isDeepStrictEqual } = require("node:util");
const { readFileSync } = require("node:fs");

const generated = JSON.parse(process.argv[1]);
let live = JSON.parse(readFileSync(0, "utf8"));
if (typeof live === "string") live = JSON.parse(live);
process.exit(isDeepStrictEqual(generated, live) ? 0 : 1);
' "$policy_doc" <<< "$live_policy_doc"; then
      info "Managed policy ${policy_name} drifted from bootstrap.sh — creating a new version..."

      # IAM allows at most 5 versions per policy. Delete the oldest
      # non-default versions until there is room for the new one.
      local version_count
      version_count=$($AWS iam list-policy-versions \
        --policy-arn "$policy_arn" \
        --query 'length(Versions)' \
        --output text)
      while [[ "$version_count" -ge 5 ]]; do
        local oldest_version_id
        oldest_version_id=$($AWS iam list-policy-versions \
          --policy-arn "$policy_arn" \
          --query 'sort_by(Versions[?IsDefaultVersion==`false`], &CreateDate)[0].VersionId' \
          --output text)
        $AWS iam delete-policy-version \
          --policy-arn "$policy_arn" \
          --version-id "$oldest_version_id"
        info "Deleted old policy version $oldest_version_id"
        version_count=$((version_count - 1))
      done

      $AWS iam create-policy-version \
        --policy-arn "$policy_arn" \
        --policy-document "$policy_doc" \
        --set-as-default
      success "Managed policy ${policy_name} updated to match bootstrap.sh"
    else
      success "Managed policy ${policy_name} already in sync with bootstrap.sh"
    fi
  else
    info "Creating managed policy ${policy_name}..."
    $AWS iam create-policy \
      --policy-name "$policy_name" \
      --policy-document "$policy_doc"
    success "Managed policy ${policy_name} created"
  fi

  info "Checking managed policy ${policy_name} is attached to role ${GITHUB_ACTIONS_ROLE}..."
  if $AWS iam list-attached-role-policies --role-name "$GITHUB_ACTIONS_ROLE" \
      --query "AttachedPolicies[?PolicyArn=='${policy_arn}']" --output text | grep -q .; then
    success "Managed policy ${policy_name} already attached"
  else
    info "Attaching managed policy ${policy_name} to role..."
    $AWS iam attach-role-policy \
      --role-name "$GITHUB_ACTIONS_ROLE" \
      --policy-arn "$policy_arn"
    success "Managed policy ${policy_name} attached"
  fi
}

for DEPLOY_ENVIRONMENT in production qa; do
GITHUB_ACTIONS_ROLE="petroglyph-github-actions-deploy-${DEPLOY_ENVIRONMENT}"
DEPLOY_POLICY_NAME="petroglyph-github-actions-deploy-${DEPLOY_ENVIRONMENT}"
DEPLOY_WORKLOADS_POLICY_NAME="${DEPLOY_POLICY_NAME}-workloads"

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
            \"token.actions.githubusercontent.com:sub\": \"repo:jaybeeuu/petroglyph:environment:${DEPLOY_ENVIRONMENT}\",
            \"token.actions.githubusercontent.com:aud\": \"sts.amazonaws.com\"
          }
        }
      }]
    }"
  success "Deploy role created"
fi

# NOTE: LambdaProjectFunctions and ProjectQueues name every function/queue ARN
# explicitly, matching DynamoDbProjectTables. LambdaEventSourceMappings scopes
# to the mapping ARNs, but lambda:CreateEventSourceMapping and
# lambda:ListEventSourceMappings do not support resource-level permissions, so
# they need "Resource": "*". Only CreateEventSourceMapping and
# ListEventSourceMappings are non-scopable; GetEventSourceMapping and the other
# mapping actions are scoped. This exception is justified in docs/ops.md.
#
# The statements are authored once, then split into two managed policies below
# because IAM rejects a managed policy document over 6144 characters. The
# workload statements (DynamoDB tables, Lambda functions, SQS queues and their
# event-source mappings) move to <name>-workloads; everything else stays on
# <name>. Keeping every project ARN explicit is the guardrail in docs/ops.md,
# so the fix is a split, not a wildcard.
POLICY_DOC_ALL=$(cat << EOF
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
        "arn:aws:s3:::petroglyph-staged-pdfs-${DEPLOY_ENVIRONMENT}"
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
        "arn:aws:s3:::petroglyph-staged-pdfs-${DEPLOY_ENVIRONMENT}/*"
      ]
    },
    {
      "Sid": "DynamoDbProjectTables",
      "Effect": "Allow",
      "Action": [
        "dynamodb:CreateTable",
        "dynamodb:DeleteItem",
        "dynamodb:DeleteTable",
        "dynamodb:DescribeContinuousBackups",
        "dynamodb:DescribeContributorInsights",
        "dynamodb:DescribeKinesisStreamingDestination",
        "dynamodb:DescribeTable",
        "dynamodb:DescribeTimeToLive",
        "dynamodb:GetItem",
        "dynamodb:ListTagsOfResource",
        "dynamodb:PutItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:TagResource",
        "dynamodb:UntagResource",
        "dynamodb:UpdateItem",
        "dynamodb:UpdateTable",
        "dynamodb:UpdateTimeToLive"
      ],
      "Resource": [
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-terraform-locks",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-users-${DEPLOY_ENVIRONMENT}",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-refresh-tokens-${DEPLOY_ENVIRONMENT}",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-sync-profiles-${DEPLOY_ENVIRONMENT}",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-file-records-${DEPLOY_ENVIRONMENT}",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-delta-tokens-${DEPLOY_ENVIRONMENT}",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-sync-jobs-${DEPLOY_ENVIRONMENT}",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-event-log-${DEPLOY_ENVIRONMENT}",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-staged-records-${DEPLOY_ENVIRONMENT}",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-token-vaults-${DEPLOY_ENVIRONMENT}",
        "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-delta-states-${DEPLOY_ENVIRONMENT}"
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
      "Resource": [
        "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-adapter-catch-up-${DEPLOY_ENVIRONMENT}",
        "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-adapter-onedrive-${DEPLOY_ENVIRONMENT}",
        "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-api-${DEPLOY_ENVIRONMENT}",
        "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-graph-stub-${DEPLOY_ENVIRONMENT}",
        "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-ingest-onedrive-${DEPLOY_ENVIRONMENT}",
        "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-processor-${DEPLOY_ENVIRONMENT}",
        "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-staging-delivery-${DEPLOY_ENVIRONMENT}",
        "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-staging-dispatch-${DEPLOY_ENVIRONMENT}",
        "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-staging-forwarder-${DEPLOY_ENVIRONMENT}",
        "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-sync-relay-${DEPLOY_ENVIRONMENT}",
        "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:function:petroglyph-sync-worker-${DEPLOY_ENVIRONMENT}"
      ]
    },
    {
      "Sid": "LambdaEventSourceMappingUnscopable",
      "Effect": "Allow",
      "Action": [
        "lambda:CreateEventSourceMapping",
        "lambda:ListEventSourceMappings"
      ],
      "Resource": "*"
    },
    {
      "Sid": "LambdaEventSourceMappings",
      "Effect": "Allow",
      "Action": [
        "lambda:DeleteEventSourceMapping",
        "lambda:GetEventSourceMapping",
        "lambda:ListTags",
        "lambda:TagResource",
        "lambda:UntagResource",
        "lambda:UpdateEventSourceMapping"
      ],
      "Resource": "arn:aws:lambda:eu-west-2:${ACCOUNT_ID}:event-source-mapping:*"
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
      "Sid": "ProjectEventBridgeSchedules",
      "Effect": "Allow",
      "Action": [
        "events:PutRule",
        "events:PutTargets",
        "events:DeleteRule",
        "events:RemoveTargets",
        "events:DescribeRule",
        "events:TagResource",
        "events:UntagResource",
        "events:ListTagsForResource"
      ],
      "Resource": "arn:aws:events:eu-west-2:${ACCOUNT_ID}:rule/petroglyph-adapter-catch-up-${DEPLOY_ENVIRONMENT}"
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
        "sqs:SendMessage",
        "sqs:SetQueueAttributes",
        "sqs:TagQueue",
        "sqs:UntagQueue",
        "sqs:ListQueueTags"
      ],
      "Resource": [
        "arn:aws:sqs:eu-west-2:${ACCOUNT_ID}:petroglyph-delta-trigger-dlq-${DEPLOY_ENVIRONMENT}.fifo",
        "arn:aws:sqs:eu-west-2:${ACCOUNT_ID}:petroglyph-delta-trigger-${DEPLOY_ENVIRONMENT}.fifo",
        "arn:aws:sqs:eu-west-2:${ACCOUNT_ID}:petroglyph-ingest-dlq-${DEPLOY_ENVIRONMENT}",
        "arn:aws:sqs:eu-west-2:${ACCOUNT_ID}:petroglyph-ingest-${DEPLOY_ENVIRONMENT}",
        "arn:aws:sqs:eu-west-2:${ACCOUNT_ID}:petroglyph-staged-events-dlq-${DEPLOY_ENVIRONMENT}.fifo",
        "arn:aws:sqs:eu-west-2:${ACCOUNT_ID}:petroglyph-staged-events-${DEPLOY_ENVIRONMENT}.fifo",
        "arn:aws:sqs:eu-west-2:${ACCOUNT_ID}:petroglyph-sync-jobs-dlq-${DEPLOY_ENVIRONMENT}",
        "arn:aws:sqs:eu-west-2:${ACCOUNT_ID}:petroglyph-sync-jobs-${DEPLOY_ENVIRONMENT}"
      ]
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
      "Sid": "ProjectSsmParameterCrypto",
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:Encrypt",
        "kms:GenerateDataKey",
        "kms:DescribeKey"
      ],
      "Resource": "arn:aws:kms:eu-west-2:${ACCOUNT_ID}:key/*",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "ssm.eu-west-2.amazonaws.com"
        }
      }
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

# Split the authored statements into the two managed policies. The SID list is
# the single place the boundary is declared.
WORKLOAD_SIDS='["DynamoDbProjectTables","DynamoDbListTables","LambdaProjectFunctions","LambdaEventSourceMappingUnscopable","LambdaEventSourceMappings","ProjectQueues"]'

split_deploy_policy() {
  node --input-type=commonjs -e '
const sids = new Set(JSON.parse(process.argv[1]));
const doc = JSON.parse(process.argv[2]);
const keep = process.argv[3] === "workloads"
  ? (statement) => sids.has(statement.Sid)
  : (statement) => !sids.has(statement.Sid);
process.stdout.write(JSON.stringify({ Version: doc.Version, Statement: doc.Statement.filter(keep) }, null, 2));
' "$WORKLOAD_SIDS" "$POLICY_DOC_ALL" "$1"
}

POLICY_DOC=$(split_deploy_policy platform)
POLICY_DOC_WORKLOADS=$(split_deploy_policy workloads)

# Workloads first: its policy is attached before the platform policy drops the
# workload statements, so the role never loses a permission mid-converge.
converge_managed_policy "$DEPLOY_WORKLOADS_POLICY_NAME" "$POLICY_DOC_WORKLOADS"
converge_managed_policy "$DEPLOY_POLICY_NAME" "$POLICY_DOC"
done

# ── Step 7: GitHub Actions read-only plan role ───────────────────────────────
#
# This role is assumed by the PR-time terraform plan workflow
# (.github/workflows/terraform.yml) via OIDC. It is deliberately read-only: it
# may read the remote state bucket, the one SSM parameter the configuration
# resolves at plan time (data.aws_ssm_parameter.onedrive_client_id — Terraform
# reads data sources during plan even with -refresh=false), and the project
# DynamoDB table metadata that the AWS provider reads during CustomizeDiff
# (validateTableAttributes calls DescribeTable for every table resource, again
# regardless of -refresh=false). It grants no write action, so a pull-request
# job can never create, update or delete infrastructure. It does not carry the
# deploy role's Lambda / IAM / SQS / wildcard-SSM permissions or any DynamoDB
# data-plane action, and its trust is pinned to the terraform-plan environment
# subject so a PR job cannot assume the production deploy role.

PLAN_ROLE="petroglyph-github-actions-plan"
PLAN_POLICY_NAME="petroglyph-github-actions-plan"

info "Checking plan role ($PLAN_ROLE)..."
if $AWS iam get-role --role-name "$PLAN_ROLE" &>/dev/null; then
  success "Plan role already exists"
else
  info "Creating plan role..."
  $AWS iam create-role \
    --role-name "$PLAN_ROLE" \
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
            \"token.actions.githubusercontent.com:sub\": \"repo:jaybeeuu/petroglyph:environment:terraform-plan\",
            \"token.actions.githubusercontent.com:aud\": \"sts.amazonaws.com\"
          }
        }
      }]
    }"
  success "Plan role created"
fi

PLAN_POLICY_DOC=$(cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TerraformStateBucketRead",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::petroglyph-terraform-state-${ACCOUNT_ID}",
        "arn:aws:s3:::petroglyph-terraform-state-${ACCOUNT_ID}/*"
      ]
    },
    {
      "Sid": "PlanTimeParameterRead",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:eu-west-2:${ACCOUNT_ID}:parameter/petroglyph/production/onedrive/client-id"
    },
    {
      "Sid": "PlanTimeParameterDecrypt",
      "Effect": "Allow",
      "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:eu-west-2:${ACCOUNT_ID}:key/*",
      "Condition": {
        "StringEquals": {
          "kms:ViaService": "ssm.eu-west-2.amazonaws.com"
        }
      }
    },
    {
      "Sid": "PlanTimeTableMetadataRead",
      "Effect": "Allow",
      "Action": "dynamodb:DescribeTable",
      "Resource": "arn:aws:dynamodb:eu-west-2:${ACCOUNT_ID}:table/petroglyph-*"
    }
  ]
}
EOF
)

info "Checking plan inline policy ($PLAN_POLICY_NAME)..."
if $AWS iam get-role-policy --role-name "$PLAN_ROLE" --policy-name "$PLAN_POLICY_NAME" &>/dev/null; then
  LIVE_PLAN_POLICY_DOC=$($AWS iam get-role-policy \
    --role-name "$PLAN_ROLE" \
    --policy-name "$PLAN_POLICY_NAME" \
    --query 'PolicyDocument' \
    --output json)

  # IAM may normalise whitespace and key order, so compare the documents
  # semantically (as parsed JSON) rather than as raw text.
  if ! node --input-type=commonjs -e '
const { isDeepStrictEqual } = require("node:util");
const { readFileSync } = require("node:fs");

const generated = JSON.parse(process.argv[1]);
let live = JSON.parse(readFileSync(0, "utf8"));
if (typeof live === "string") live = JSON.parse(live);
process.exit(isDeepStrictEqual(generated, live) ? 0 : 1);
' "$PLAN_POLICY_DOC" <<< "$LIVE_PLAN_POLICY_DOC"; then
    info "Plan inline policy drifted from bootstrap.sh — updating..."
    $AWS iam put-role-policy \
      --role-name "$PLAN_ROLE" \
      --policy-name "$PLAN_POLICY_NAME" \
      --policy-document "$PLAN_POLICY_DOC"
    success "Plan inline policy updated to match bootstrap.sh"
  else
    success "Plan inline policy already in sync with bootstrap.sh"
  fi
else
  info "Creating plan inline policy..."
  $AWS iam put-role-policy \
    --role-name "$PLAN_ROLE" \
    --policy-name "$PLAN_POLICY_NAME" \
    --policy-document "$PLAN_POLICY_DOC"
  success "Plan inline policy created"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Bootstrap complete."
echo ""
echo "  TF_STATE_BUCKET        = $TF_STATE_BUCKET"
echo "  LAMBDA_ARTIFACT_BUCKET = $LAMBDA_ARTIFACT_BUCKET"
echo "  PLAN_ROLE_ARN          = arn:aws:iam::${ACCOUNT_ID}:role/${PLAN_ROLE}"
echo ""
echo "  Set these GitHub Actions secrets on the 'production' environment:"
echo "    AWS_ROLE_ARN           = arn:aws:iam::${ACCOUNT_ID}:role/petroglyph-github-actions-deploy-production"
echo "    TF_STATE_BUCKET        = $TF_STATE_BUCKET"
echo "    LAMBDA_ARTIFACT_BUCKET = $LAMBDA_ARTIFACT_BUCKET"
echo ""
echo "  Set these GitHub Actions secrets on the 'qa' environment:"
echo "    AWS_ROLE_ARN           = arn:aws:iam::${ACCOUNT_ID}:role/petroglyph-github-actions-deploy-qa"
echo "    TF_STATE_BUCKET        = $TF_STATE_BUCKET"
echo "    LAMBDA_ARTIFACT_BUCKET = $LAMBDA_ARTIFACT_BUCKET"
echo ""
echo "  Create a 'terraform-plan' environment (no branch restriction) with:"
echo "    AWS_PLAN_ROLE_ARN      = arn:aws:iam::${ACCOUNT_ID}:role/${PLAN_ROLE}"
echo "    TF_STATE_BUCKET        = $TF_STATE_BUCKET"
echo "    LAMBDA_ARTIFACT_BUCKET = $LAMBDA_ARTIFACT_BUCKET"
echo ""
echo "  The plan workflow skips cleanly until AWS_PLAN_ROLE_ARN is set."
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
