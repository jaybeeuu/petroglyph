#!/usr/bin/env bash
# One-time SSM namespace migration (petroglyph-up9y.3).
#
# Before the QA tier existed every SSM parameter lived at a global
# /petroglyph/<category>/<leaf> path. They are now namespaced as
# /petroglyph/<workspace>/<category>/<leaf> so a second workspace cannot collide
# with production. Because aws_ssm_parameter.name is ForceNew, Terraform
# *replaces* each parameter on the rename — destroying the hand-entered
# SecureString values. This script copies those values out first, applies the
# rename, then writes them back to the namespaced paths, so no secret is
# re-keyed by hand.
#
# Run once, as petroglyph-admin, before the first deploy that carries the
# namespaced ssm.tf:
#
#   ./scripts/migrate-ssm-namespace.sh --profile petroglyph-admin --workspace production
#
# The snapshot it writes is chmod 600 and holds the plaintext values; it is the
# rollback artefact. Delete it once the namespaced parameters are verified.
set -euo pipefail

# Directory containing this script, so helper tools can be referenced
# regardless of the working directory the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Defaults ────────────────────────────────────────────────────────────────

PROFILE="petroglyph-admin"
WORKSPACE="production"
REGION="eu-west-2"
SNAPSHOT=""

# ── Argument parsing ─────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)   PROFILE="$2";   shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --region)    REGION="$2";    shift 2 ;;
    --snapshot)  SNAPSHOT="$2";  shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

AWS="aws --profile $PROFILE --region $REGION"
export AWS_PAGER=""

# ── Helpers ───────────────────────────────────────────────────────────────────

info()    { echo "▶  $*"; }
success() { echo "✓  $*"; }
fail()    { echo "✗  $*" >&2; exit 1; }

LEGACY_ROOT="/petroglyph"
TARGET_ROOT="/petroglyph/${WORKSPACE}"

if [[ -z "$SNAPSHOT" ]]; then
  SNAPSHOT="$INFRA_DIR/ssm-namespace-snapshot-${WORKSPACE}-$(date -u +%Y%m%dT%H%M%SZ).json"
fi

# ── Step 1: Verify credentials ────────────────────────────────────────────────

info "Verifying AWS credentials (profile: $PROFILE)..."
ACCOUNT_ID=$($AWS sts get-caller-identity --query Account --output text 2>/dev/null) \
  || fail "Cannot authenticate with profile '$PROFILE'. Run: aws sso login --profile $PROFILE"
success "Authenticated — account $ACCOUNT_ID"

# ── Step 2: Snapshot the legacy (unnamespaced) parameters ─────────────────────
#
# Legacy parameters are /petroglyph/<category>/<leaf> (three segments below the
# root); namespaced ones are /petroglyph/<workspace>/<category>/<leaf>. Selecting
# on the segment count picks up exactly the legacy set for any workspace and
# never re-snapshots an already-namespaced parameter belonging to another tier.

info "Snapshotting legacy parameters under ${LEGACY_ROOT}/..."
LEGACY_PARAMETERS=$($AWS ssm get-parameters-by-path \
  --path "$LEGACY_ROOT" --recursive --with-decryption \
  --query 'Parameters' --output json)

SNAPSHOT_COUNT=$(node --input-type=commonjs -e '
const { readFileSync, writeFileSync } = require("node:fs");
const [, workspace, snapshotPath] = process.argv;
const legacy = JSON.parse(readFileSync(0, "utf8"));
const parameters = legacy.filter((parameter) => parameter.Name.split("/").length === 4);
writeFileSync(snapshotPath, JSON.stringify({ workspace, parameters }, null, 2), { mode: 0o600 });
process.stdout.write(String(parameters.length));
' "$WORKSPACE" "$SNAPSHOT" <<< "$LEGACY_PARAMETERS")
success "Snapshot written to $SNAPSHOT ($SNAPSHOT_COUNT legacy parameters)"

if [[ "$SNAPSHOT_COUNT" -eq 0 ]]; then
  success "No legacy parameters remain — nothing to migrate."
  exit 0
fi

# ── Step 3: Apply the rename ──────────────────────────────────────────────────
#
# Only the aws_ssm_parameter resources are targeted: everything else in the
# workspace is left untouched, and the required Lambda artifact variables are
# placeholders because no Lambda resource is planned.

info "Applying the namespaced SSM resources (workspace: $WORKSPACE)..."
cd "$INFRA_DIR"

TF_STATE_BUCKET="petroglyph-terraform-state-${ACCOUNT_ID}"
AWS_PROFILE="$PROFILE" terraform init -reconfigure \
  -backend-config="bucket=$TF_STATE_BUCKET" \
  -backend-config="key=petroglyph/terraform.tfstate" \
  -backend-config="region=$REGION" \
  -backend-config="dynamodb_table=petroglyph-terraform-locks" \
  -backend-config="encrypt=true" >/dev/null

AWS_PROFILE="$PROFILE" terraform workspace select "$WORKSPACE" 2>/dev/null \
  || AWS_PROFILE="$PROFILE" terraform workspace new "$WORKSPACE"

# A -target plan must still include every instance whose state address has moved
# in the current configuration, or Terraform aborts with "Moved resource
# instances excluded by targeting". The four DLQ alarms gained
# `count = terraform.workspace == "production" ? 1 : 0` in the same change that
# namespaced SSM, so their addresses move to `[0]`. Include any that are still
# at the unindexed address; the move itself is a state-only no-op.
#
# The alarms were deleted afterwards (petroglyph-60ej.2) and this migration has
# long since run, but the list stays. The loop below only adds an address the
# workspace state actually carries, so against today's state — which holds no
# alarm instance at all — it adds nothing and the script behaves exactly as if
# the list were empty.
MOVED_RESOURCES=(
  aws_cloudwatch_metric_alarm.delta_trigger_dlq_depth
  aws_cloudwatch_metric_alarm.ingest_dlq_depth
  aws_cloudwatch_metric_alarm.staged_events_dlq_depth
  aws_cloudwatch_metric_alarm.sync_jobs_dlq_depth
)

TARGETS=()
while IFS= read -r address; do
  [[ -n "$address" ]] && TARGETS+=("-target=$address")
done < <(AWS_PROFILE="$PROFILE" terraform state list | grep -E '^aws_ssm_parameter\.' || true)

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  fail "No aws_ssm_parameter resources in the $WORKSPACE state — apply the stack first."
fi
SSM_TARGET_COUNT="${#TARGETS[@]}"

for address in "${MOVED_RESOURCES[@]}"; do
  if AWS_PROFILE="$PROFILE" terraform state list "$address" 2>/dev/null | grep -qx "$address"; then
    TARGETS+=("-target=$address")
  fi
done

AWS_PROFILE="$PROFILE" terraform apply -auto-approve -refresh=false "${TARGETS[@]}" \
  -var="api_zip_s3_bucket=unused" \
  -var="api_zip_s3_key=unused" >/dev/null
success "Rename applied — $SSM_TARGET_COUNT namespaced parameters in place"

# ── Step 4: Restore the values to the namespaced paths ────────────────────────

info "Restoring parameter values to ${TARGET_ROOT}/..."
RESTORED=$(PROFILE="$PROFILE" REGION="$REGION" node --input-type=commonjs -e '
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const [, snapshotPath, workspace] = process.argv;
const { parameters } = JSON.parse(readFileSync(snapshotPath, "utf8"));
const prefix = `/petroglyph/${workspace}/`;
for (const parameter of parameters) {
  const suffix = parameter.Name.slice("/petroglyph/".length);
  execFileSync(
    "aws",
    [
      "--profile", process.env.PROFILE,
      "--region", process.env.REGION,
      "ssm", "put-parameter",
      "--name", prefix + suffix,
      // Keep the value in the same argument as the flag: the AWS CLI argparser
      // reads a separate `--value <v>` as an option when <v> starts with "-"
      // and contains no space (an Azure client secret, say), and fails with
      // "argument --value: expected one argument".
      "--value=" + (parameter.Value ?? ""),
      "--type", parameter.Type,
      "--overwrite",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
}
process.stdout.write(String(parameters.length));
' "$SNAPSHOT" "$WORKSPACE")
success "Restored $RESTORED parameter values"

# ── Step 5: Verify ────────────────────────────────────────────────────────────

info "Verifying namespaced parameters under ${TARGET_ROOT}/..."
$AWS ssm get-parameters-by-path --path "$TARGET_ROOT" --recursive \
  --query 'Parameters[].Name' --output text

echo ""
success "Migration complete. Keep $SNAPSHOT until the values are verified, then delete it."
