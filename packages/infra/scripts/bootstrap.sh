#!/usr/bin/env bash
# Bootstrap Petroglyph AWS infrastructure.
#
# Creates the Terraform remote state bucket, DynamoDB lock table, and Lambda
# artifact bucket, then runs terraform init, workspace setup, plan, apply, and
# verification checks.  All operations are idempotent — safe to re-run.
#
# Usage:
#   ./bootstrap.sh [--profile <aws-profile>] [--workspace <terraform-workspace>]
#
# Defaults:
#   --profile    petroglyph-admin
#   --workspace  production

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────

PROFILE="petroglyph-admin"
WORKSPACE="production"
REGION="eu-west-2"

# ── Argument parsing ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)   PROFILE="$2";   shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

AWS="aws --profile $PROFILE --region $REGION"
export AWS_PAGER=""

# ── Helpers ───────────────────────────────────────────────────────────────────

info()    { echo "▶  $*"; }
success() { echo "✓  $*"; }
fail()    { echo "✗  $*" >&2; exit 1; }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    success "$label"
  else
    fail "$label — expected '$expected', got '$actual'"
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    success "$label"
  else
    fail "$label — '$needle' not found in output"
  fi
}

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

# ── Step 7: Upload placeholder Lambda zip ────────────────────────────────────

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

# ── Step 8: Terraform init ────────────────────────────────────────────────────

INFRA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$INFRA_DIR"

info "Running terraform init..."
AWS_PROFILE="$PROFILE" terraform init \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="key=$TF_STATE_KEY" \
  -backend-config="region=$REGION" \
  -backend-config="dynamodb_table=$DYNAMODB_LOCK_TABLE" \
  -backend-config="encrypt=true" \
  -reconfigure
success "Terraform init complete"

# ── Step 6: Workspace ─────────────────────────────────────────────────────────

info "Selecting workspace: $WORKSPACE..."
AWS_PROFILE="$PROFILE" terraform workspace select "$WORKSPACE" 2>/dev/null \
  || AWS_PROFILE="$PROFILE" terraform workspace new "$WORKSPACE"
success "Workspace: $WORKSPACE"

# ── Step 7: Plan (assert no destroys) ────────────────────────────────────────

info "Running terraform plan..."
PLAN_OUT=$(AWS_PROFILE="$PROFILE" terraform plan \
  -var="api_zip_s3_bucket=$LAMBDA_ARTIFACT_BUCKET" \
  -var="api_zip_s3_key=$PLACEHOLDER_KEY" \
  -no-color 2>&1)

if echo "$PLAN_OUT" | grep -qE "[1-9][0-9]* to destroy"; then
  fail "Plan contains destroys — aborting. Review the plan:\n$PLAN_OUT"
fi
success "Plan contains no destroys"

# ── Step 8: Apply ─────────────────────────────────────────────────────────────

info "Running terraform apply..."
AWS_PROFILE="$PROFILE" terraform apply \
  -var="api_zip_s3_bucket=$LAMBDA_ARTIFACT_BUCKET" \
  -var="api_zip_s3_key=$PLACEHOLDER_KEY" \
  -auto-approve
success "Apply complete"

# ── Step 9: Verification ──────────────────────────────────────────────────────

info "Running verification checks..."

# DynamoDB tables (expect 4)
TABLES=$($AWS dynamodb list-tables --query 'TableNames[?contains(@, `petroglyph`)]' --output text)
for table in \
  "petroglyph-file-records-${WORKSPACE}" \
  "petroglyph-refresh-tokens-${WORKSPACE}" \
  "petroglyph-sync-profiles-${WORKSPACE}" \
  "petroglyph-users-${WORKSPACE}"; do
  assert_contains "DynamoDB table: $table" "$table" "$TABLES"
done

# S3 bucket
$AWS s3api head-bucket --bucket "petroglyph-staged-pdfs-${WORKSPACE}" \
  && success "S3 bucket: petroglyph-staged-pdfs-${WORKSPACE}" \
  || fail "S3 bucket not found: petroglyph-staged-pdfs-${WORKSPACE}"

# S3 lifecycle rule
LIFECYCLE=$($AWS s3api get-bucket-lifecycle-configuration \
  --bucket "petroglyph-staged-pdfs-${WORKSPACE}" --output text 2>&1)
assert_contains "S3 lifecycle rule enabled" "Enabled" "$LIFECYCLE"

# SSM parameters
PARAMS=$($AWS ssm get-parameters-by-path \
  --path /petroglyph/ --recursive \
  --query 'Parameters[].Name' --output text)
PARAM_COUNT=$(echo "$PARAMS" | wc -w)
if [[ "$PARAM_COUNT" -ge 12 ]]; then
  success "SSM parameters: $PARAM_COUNT found (expected 12)"
else
  fail "SSM parameters: expected 12, got $PARAM_COUNT"
fi

# IAM roles
for role in \
  "petroglyph-api-${WORKSPACE}" \
  "petroglyph-ingest-onedrive-${WORKSPACE}" \
  "petroglyph-processor-${WORKSPACE}"; do
  $AWS iam get-role --role-name "$role" --query 'Role.RoleName' --output text &>/dev/null \
    && success "IAM role: $role" \
    || fail "IAM role not found: $role"
done

# ── Step 10: Idempotency check ────────────────────────────────────────────────

info "Idempotency check (second apply)..."
IDEMPOTENT_OUT=$(AWS_PROFILE="$PROFILE" terraform apply \
  -var="api_zip_s3_bucket=$LAMBDA_ARTIFACT_BUCKET" \
  -var="api_zip_s3_key=$PLACEHOLDER_KEY" \
  -auto-approve \
  -no-color 2>&1)
assert_contains "Idempotency" "No changes" "$IDEMPOTENT_OUT"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Bootstrap complete. Record these values for dv4.13:"
echo ""
echo "  TF_STATE_BUCKET      = $TF_STATE_BUCKET"
echo "  LAMBDA_ARTIFACT_BUCKET = $LAMBDA_ARTIFACT_BUCKET"
echo "════════════════════════════════════════════════════════"
