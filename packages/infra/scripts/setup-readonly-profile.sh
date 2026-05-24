#!/usr/bin/env bash
# Create the petroglyph-readonly IAM user + policy and configure the local
# AWS profile so it is immediately usable.
#
# Usage:
#   ./setup-readonly-profile.sh [--profile <admin-profile>]
#
# Defaults:
#   --profile    petroglyph-admin

set -euo pipefail

PROFILE="petroglyph-admin"
REGION="eu-west-2"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

AWS="aws --profile $PROFILE --region $REGION"
export AWS_PAGER=""

info()    { echo "▶  $*"; }
success() { echo "✓  $*"; }
fail()    { echo "✗  $*" >&2; exit 1; }

# ── Verify credentials ────────────────────────────────────────────────────────

info "Verifying credentials (profile: $PROFILE)..."
ACCOUNT_ID=$($AWS sts get-caller-identity --query Account --output text 2>/dev/null) \
  || fail "Cannot authenticate with profile '$PROFILE'."
success "Authenticated — account $ACCOUNT_ID"

READONLY_USER="petroglyph-readonly"
READONLY_POLICY_NAME="petroglyph-readonly"
READONLY_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${READONLY_POLICY_NAME}"

READONLY_POLICY_DOC=$(cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DynamoDBRead",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:Scan",
        "dynamodb:DescribeTable",
        "dynamodb:ListTables"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SSMRead",
      "Effect": "Allow",
      "Action": [
        "ssm:GetParameter",
        "ssm:GetParameters",
        "ssm:GetParametersByPath",
        "ssm:DescribeParameters"
      ],
      "Resource": "arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/petroglyph/*"
    },
    {
      "Sid": "LambdaRead",
      "Effect": "Allow",
      "Action": [
        "lambda:GetFunction",
        "lambda:GetFunctionConfiguration",
        "lambda:ListFunctions",
        "lambda:ListVersionsByFunction"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudWatchLogsRead",
      "Effect": "Allow",
      "Action": [
        "logs:DescribeLogGroups",
        "logs:DescribeLogStreams",
        "logs:FilterLogEvents",
        "logs:GetLogEvents",
        "logs:StartQuery",
        "logs:GetQueryResults"
      ],
      "Resource": "*"
    }
  ]
}
EOF
)

# ── Create managed policy ─────────────────────────────────────────────────────

info "Checking readonly managed policy..."
if $AWS iam get-policy --policy-arn "$READONLY_POLICY_ARN" &>/dev/null; then
  success "Policy already exists"
else
  info "Creating policy $READONLY_POLICY_NAME..."
  $AWS iam create-policy \
    --policy-name "$READONLY_POLICY_NAME" \
    --policy-document "$READONLY_POLICY_DOC" \
    --query 'Policy.Arn' --output text
  success "Policy created"
fi

# ── Create IAM user ───────────────────────────────────────────────────────────

info "Checking IAM user $READONLY_USER..."
if $AWS iam get-user --user-name "$READONLY_USER" &>/dev/null; then
  success "User already exists"
else
  info "Creating IAM user $READONLY_USER..."
  $AWS iam create-user --user-name "$READONLY_USER" \
    --tags Key=purpose,Value=local-readonly
  success "User created"
fi

# ── Attach policy ─────────────────────────────────────────────────────────────

info "Checking policy attachment..."
if $AWS iam list-attached-user-policies --user-name "$READONLY_USER" \
    --query "AttachedPolicies[?PolicyArn=='${READONLY_POLICY_ARN}']" \
    --output text | grep -q .; then
  success "Policy already attached"
else
  info "Attaching policy..."
  $AWS iam attach-user-policy \
    --user-name "$READONLY_USER" \
    --policy-arn "$READONLY_POLICY_ARN"
  success "Policy attached"
fi

# ── Create access key ─────────────────────────────────────────────────────────

info "Creating access key for $READONLY_USER..."
KEY_JSON=$($AWS iam create-access-key --user-name "$READONLY_USER" \
  --query 'AccessKey.{id:AccessKeyId,secret:SecretAccessKey}' \
  --output json)
KEY_ID=$(echo "$KEY_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
KEY_SECRET=$(echo "$KEY_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['secret'])")
success "Access key created: $KEY_ID"

# ── Write ~/.aws/credentials ──────────────────────────────────────────────────

CREDS_FILE="${HOME}/.aws/credentials"
CONFIG_FILE="${HOME}/.aws/config"

info "Writing credentials to $CREDS_FILE..."
mkdir -p "${HOME}/.aws"

# Remove existing [petroglyph-readonly] block if present
if grep -q '^\[petroglyph-readonly\]' "$CREDS_FILE" 2>/dev/null; then
  python3 - <<PY
import re, pathlib
p = pathlib.Path("$CREDS_FILE")
content = p.read_text()
content = re.sub(r'\[petroglyph-readonly\][^\[]*', '', content)
p.write_text(content)
PY
  info "Removed existing petroglyph-readonly credentials entry"
fi

cat >> "$CREDS_FILE" << CREDS

[petroglyph-readonly]
aws_access_key_id     = ${KEY_ID}
aws_secret_access_key = ${KEY_SECRET}
CREDS
success "Credentials written"

# ── Write ~/.aws/config ───────────────────────────────────────────────────────

info "Writing profile to $CONFIG_FILE..."
touch "$CONFIG_FILE"

if grep -q '^\[profile petroglyph-readonly\]' "$CONFIG_FILE" 2>/dev/null; then
  success "Profile already in config"
else
  cat >> "$CONFIG_FILE" << CONFIG

[profile petroglyph-readonly]
region = ${REGION}
CONFIG
  success "Profile written to config"
fi

# ── Verify ────────────────────────────────────────────────────────────────────

info "Verifying new profile..."
IDENTITY=$(aws --profile petroglyph-readonly sts get-caller-identity \
  --query 'Arn' --output text 2>/dev/null) \
  || fail "Profile verification failed — check ~/.aws/credentials"
success "petroglyph-readonly is ready: $IDENTITY"

echo ""
echo "════════════════════════════════════════════════════════════════"
echo "  petroglyph-readonly profile is configured and verified."
echo "  Use --profile petroglyph-readonly for day-to-day AWS access."
echo "════════════════════════════════════════════════════════════════"
