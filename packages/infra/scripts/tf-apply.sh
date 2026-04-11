#!/usr/bin/env bash
# Provision Petroglyph application infrastructure with Terraform.
#
# Runs terraform init (wiring the S3 remote backend), selects or creates the
# target workspace, runs a plan (aborting if any destroys are detected), and
# applies.  Optionally runs a post-apply verification of expected resources.
#
# Run `./scripts/bootstrap.sh` once before this script to ensure the remote
# backend S3 bucket, DynamoDB lock table, and Lambda artifact bucket exist.
#
# Usage:
#   ./tf-apply.sh [--profile <aws-profile>] [--workspace <terraform-workspace>]
#                 [--api-zip-bucket <bucket>] [--api-zip-key <key>]
#
# Defaults:
#   --profile    petroglyph-admin
#   --workspace  production

set -euo pipefail

# ── Defaults ────────────────────────────────────────────────────────────────

PROFILE="petroglyph-admin"
WORKSPACE="production"
REGION="eu-west-2"
API_ZIP_BUCKET=""
API_ZIP_KEY=""

# ── Argument parsing ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)        PROFILE="$2";        shift 2 ;;
    --workspace)      WORKSPACE="$2";      shift 2 ;;
    --api-zip-bucket) API_ZIP_BUCKET="$2"; shift 2 ;;
    --api-zip-key)    API_ZIP_KEY="$2";    shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

AWS="aws --profile $PROFILE --region $REGION"
export AWS_PAGER=""

# ── Helpers ───────────────────────────────────────────────────────────────────

info()    { echo "▶  $*"; }
success() { echo "✓  $*"; }
fail()    { echo "✗  $*" >&2; exit 1; }

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if echo "$haystack" | grep -q "$needle"; then
    success "$label"
  else
    fail "$label — '$needle' not found in output"
  fi
}

# ── Resolve backend resources from AWS ───────────────────────────────────────

info "Resolving backend resources (profile: $PROFILE)..."
ACCOUNT_ID=$($AWS sts get-caller-identity --query Account --output text 2>/dev/null) \
  || fail "Cannot authenticate with profile '$PROFILE'. Run: aws sso login --profile $PROFILE"
success "Authenticated — account $ACCOUNT_ID"

TF_STATE_BUCKET="petroglyph-terraform-state-${ACCOUNT_ID}"
DYNAMODB_LOCK_TABLE="petroglyph-terraform-locks"
TF_STATE_KEY="petroglyph/terraform.tfstate"

if [[ -z "$API_ZIP_BUCKET" ]]; then
  API_ZIP_BUCKET="petroglyph-lambda-artifacts-${ACCOUNT_ID}"
fi
if [[ -z "$API_ZIP_KEY" ]]; then
  API_ZIP_KEY="placeholder/lambda.zip"
fi

# ── Terraform init ────────────────────────────────────────────────────────────

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

# ── Workspace ─────────────────────────────────────────────────────────────────

info "Selecting workspace: $WORKSPACE..."
AWS_PROFILE="$PROFILE" terraform workspace select "$WORKSPACE" 2>/dev/null \
  || AWS_PROFILE="$PROFILE" terraform workspace new "$WORKSPACE"
success "Workspace: $WORKSPACE"

# ── Plan (abort on destroys) ──────────────────────────────────────────────────

info "Running terraform plan..."
PLAN_OUT=$(AWS_PROFILE="$PROFILE" terraform plan \
  -var="api_zip_s3_bucket=$API_ZIP_BUCKET" \
  -var="api_zip_s3_key=$API_ZIP_KEY" \
  -no-color 2>&1)

if echo "$PLAN_OUT" | grep -qE "[1-9][0-9]* to destroy"; then
  fail "Plan contains destroys — aborting. Review the plan:\n$PLAN_OUT"
fi
success "Plan contains no destroys"

# ── Apply ─────────────────────────────────────────────────────────────────────

info "Running terraform apply..."
AWS_PROFILE="$PROFILE" terraform apply \
  -var="api_zip_s3_bucket=$API_ZIP_BUCKET" \
  -var="api_zip_s3_key=$API_ZIP_KEY" \
  -auto-approve
success "Apply complete"

# ── Verification ──────────────────────────────────────────────────────────────

info "Running verification checks..."

TABLES=$($AWS dynamodb list-tables --query 'TableNames[?contains(@, `petroglyph`)]' --output text)
for table in \
  "petroglyph-file-records-${WORKSPACE}" \
  "petroglyph-refresh-tokens-${WORKSPACE}" \
  "petroglyph-sync-profiles-${WORKSPACE}" \
  "petroglyph-users-${WORKSPACE}"; do
  assert_contains "DynamoDB table: $table" "$table" "$TABLES"
done

$AWS s3api head-bucket --bucket "petroglyph-staged-pdfs-${WORKSPACE}" \
  && success "S3 bucket: petroglyph-staged-pdfs-${WORKSPACE}" \
  || fail "S3 bucket not found: petroglyph-staged-pdfs-${WORKSPACE}"

LIFECYCLE=$($AWS s3api get-bucket-lifecycle-configuration \
  --bucket "petroglyph-staged-pdfs-${WORKSPACE}" --output text 2>&1)
assert_contains "S3 lifecycle rule enabled" "Enabled" "$LIFECYCLE"

PARAMS=$($AWS ssm get-parameters-by-path \
  --path /petroglyph/ --recursive \
  --query 'Parameters[].Name' --output text)
PARAM_COUNT=$(echo "$PARAMS" | wc -w)
if [[ "$PARAM_COUNT" -ge 12 ]]; then
  success "SSM parameters: $PARAM_COUNT found (expected 12)"
else
  fail "SSM parameters: expected 12, got $PARAM_COUNT"
fi

for role in \
  "petroglyph-api-${WORKSPACE}" \
  "petroglyph-ingest-onedrive-${WORKSPACE}" \
  "petroglyph-processor-${WORKSPACE}"; do
  $AWS iam get-role --role-name "$role" --query 'Role.RoleName' --output text &>/dev/null \
    && success "IAM role: $role" \
    || fail "IAM role not found: $role"
done

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Apply complete — workspace: $WORKSPACE"
echo "════════════════════════════════════════════════════════"
