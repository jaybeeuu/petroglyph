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

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  Bootstrap complete."
echo ""
echo "  TF_STATE_BUCKET        = $TF_STATE_BUCKET"
echo "  LAMBDA_ARTIFACT_BUCKET = $LAMBDA_ARTIFACT_BUCKET"
echo ""
echo "  Next step: pnpm tf:apply --profile $PROFILE"
echo "════════════════════════════════════════════════════════════════"
