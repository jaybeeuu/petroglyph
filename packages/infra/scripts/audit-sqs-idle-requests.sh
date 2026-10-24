#!/usr/bin/env bash
# Audit SQS request volume and event source mapping state.
#
# WHY THIS EXISTS
#
# A Lambda SQS event source mapping long-polls its queue whether or not a
# message exists. Every empty receive is a billed request against the account's
# 1,000,000 requests/month free tier, so an *idle* system still spends requests:
# five pollers long-polling for 20s is ~15 empty receives a minute per queue.
# "Nobody used the app" therefore does not mean "no SQS cost".
#
# This script separates the two sources of request volume:
#
#   NumberOfEmptyReceives  idle pollers — no message to deliver
#   NumberOfMessagesSent   real work
#
# Empty receives dominating, with sent/received/deleted near zero, is the
# signature of idle polling. Anything else is a bug worth chasing instead
# (a redelivery loop, a poison message, a runaway producer).
#
# Queues are discovered from CloudWatch metric dimensions rather than
# sqs:ListQueues: a scoped IAM role can return an empty list from ListQueues
# while the queues demonstrably exist.
#
# Usage:
#   ./audit-sqs-idle-requests.sh [--profile <aws-profile>] [--region <region>] [--days <n>]
#
# Defaults:
#   --profile  petroglyph-admin
#   --region   eu-west-2
#   --days     30      (must be <= 63: CloudWatch keeps 1-hour datapoints that long)

set -euo pipefail

PROFILE="petroglyph-admin"
REGION="eu-west-2"
DAYS="30"

while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --region)  REGION="$2";  shift 2 ;;
    --days)    DAYS="$2";    shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [ "$DAYS" -gt 63 ]; then
  echo "--days must be <= 63 (CloudWatch 1-hour retention)" >&2
  exit 64
fi

AWS=(aws --profile "$PROFILE" --region "$REGION")
START=$(date -u -d "$DAYS days ago" +%Y-%m-%dT%H:%M:%SZ)
END=$(date -u +%Y-%m-%dT%H:%M:%SZ)

echo "SQS idle-request audit"
echo "  account:   $("${AWS[@]}" sts get-caller-identity --query Account --output text)"
echo "  region:    $REGION"
echo "  window:    $START .. $END ($DAYS days, 1h periods)"
echo

QUEUES=$("${AWS[@]}" cloudwatch list-metrics --namespace AWS/SQS \
  --query 'Metrics[].Dimensions[?Name==`QueueName`].Value' --output text \
  | tr '\t' '\n' | sort -u)

if [ -z "$QUEUES" ]; then
  echo "No SQS metrics in the window — nothing is (or was) polling." >&2
  exit 0
fi

# queue <TAB> metric <TAB> summed value
ROWS=$(mktemp)
trap 'rm -f "$ROWS"' EXIT

for queue in $QUEUES; do
  for metric in NumberOfEmptyReceives NumberOfMessagesSent NumberOfMessagesReceived NumberOfMessagesDeleted; do
    value=$("${AWS[@]}" cloudwatch get-metric-statistics --namespace AWS/SQS \
      --metric-name "$metric" \
      --dimensions Name=QueueName,Value="$queue" \
      --start-time "$START" --end-time "$END" \
      --period 3600 --statistics Sum \
      --query 'sum(Datapoints[].Sum)' --output text 2>/dev/null || echo None)
    [ "$value" = "None" ] && value=0
    printf '%s\t%s\t%.0f\n' "$queue" "$metric" "$value" >> "$ROWS"
  done
done

echo "Per queue ($DAYS-day totals)"
printf '%-46s %12s %12s %12s %12s\n' "queue" "emptyRecv" "sent" "received" "deleted"
awk -F'\t' '
  { v[$1 SUBSEP $2] = $3; q[$1] = 1 }
  END {
    for (name in q) {
      printf "%-46s %12.0f %12.0f %12.0f %12.0f\n", name,
        v[name SUBSEP "NumberOfEmptyReceives"],
        v[name SUBSEP "NumberOfMessagesSent"],
        v[name SUBSEP "NumberOfMessagesReceived"],
        v[name SUBSEP "NumberOfMessagesDeleted"]
    }
  }' "$ROWS" | sort
echo

echo "Totals"
awk -F'\t' '
  { sum[$2] += $3 }
  END {
    empty = sum["NumberOfEmptyReceives"]; sent = sum["NumberOfMessagesSent"]
    recv  = sum["NumberOfMessagesReceived"]; del = sum["NumberOfMessagesDeleted"]
    printf "  empty receives:  %12.0f  (%.1f%% of the 1,000,000/month free tier)\n", empty, empty / 1000000 * 100
    printf "  messages sent:   %12.0f\n", sent
    printf "  messages recv:   %12.0f\n", recv
    printf "  messages del:    %12.0f\n", del
    if (sent + recv + del > 0 && empty / (sent + recv + del) > 100)
      printf "\n  Verdict: empty receives dominate (%.0f:1) — idle polling, not real traffic.\n", empty / (sent + recv + del)
    else if (sent + recv + del > 0)
      printf "\n  Verdict: real traffic is comparable to empty receives — investigate before redesigning anything.\n"
    else
      printf "\n  Verdict: zero messages in the window — every request was an empty receive.\n"
  }' "$ROWS"
echo

echo "Event source mappings"
"${AWS[@]}" lambda list-event-source-mappings \
  --query 'EventSourceMappings[].{source:EventSourceArn,state:State,reason:StateTransitionReason,modified:LastModified}' \
  --output table \
  | sed 's/arn:aws:[a-z]*:[a-z0-9-]*:[0-9]*://'
