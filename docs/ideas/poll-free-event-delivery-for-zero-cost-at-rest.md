# Idea: Poll-free event delivery for zero cost at rest

## Status

**Deferred** (2026-10-24). Not implementation-ready; revisit on any of the triggers below.

## Why it might be useful

Petroglyph is meant to be zero cost at rest, but every SQS consumer is a **poller**: a Lambda event source mapping long-polls its queue whether or not a message exists, and every empty receive is a billed request. The 30 days to 2026-10-24 measured **937,587 empty receives against 1 message sent and 4 received** — 93.8% of the 1,000,000/month free tier, all of it produced by idle polling.

Nothing else in the stack bills per request while idle. Lambda, API Gateway and the two DynamoDB-stream event source mappings charge nothing without traffic. Stored bytes bill per GB-month regardless of traffic — DynamoDB items and S3 objects alike, with staged PDFs expiring after 90 days — so what idleness produces is the delivery requests, and a push-based transport is the only design change that removes them. CloudWatch Logs is a retention cost that follows activity, a separate decision recorded below.

## Measured attribution

The ~850k requests in the SQS usage notification that prompted this idea were idle polling, not traffic. Measured with `packages/infra/scripts/audit-sqs-idle-requests.sh` (CloudWatch, 30 days to 2026-10-24, both workspaces, 1-hour periods):

| Queues                                                                             | Empty receives | Sent | Received | Deleted |
| ---------------------------------------------------------------------------------- | -------------- | ---- | -------- | ------- |
| 4 × production (`ingest`, `sync-jobs`, `delta-trigger.fifo`, `staged-events.fifo`) | 723,946        | 0    | 0        | 0       |
| 4 × QA main queues                                                                 | 213,641        | 1    | 4        | 0       |
| 8 × DLQ                                                                            | 0              | 0    | 0        | 0       |
| **Total**                                                                          | **937,587**    | 1    | 4        | 0       |

The production split is `ingest-production` 237,979, `sync-jobs-production` 237,984, `delta-trigger-production.fifo` 151,835 and `staged-events-production.fifo` 96,148 — roughly 1–2 long-pollers per queue at a 20-second wait, the ordinary arithmetic of long polling rather than a redelivery loop or a runaway producer. The attribution question the idea left open is therefore closed: there is no bug to chase, and this is a transport redesign, not a fix.

## Decision

Quiesce QA's four SQS event source mappings between CI runs — a disabled mapping does not poll, so QA costs 0 idle ([QA quiesce](../ops.md#qa-quiesce-sqs-event-source-mappings)) — and **accept the measured 723,946 requests/month in production** (72.4% of the free tier) until `m0jc.3` retires the legacy ingestion path. The redesign is deferred, not rejected.

`m0jc.3` retires two of the four production pollers — the two busiest, `ingest` 237,979 and `sync-jobs` 237,984, 475,963 of the 723,946 requests — so it should remove roughly two-thirds of the figure, leaving ~248,000. That is a projection, not a measurement: the audit script re-measures once the legacy path is gone.

## Why the redesign was not taken now

- **Stream shards widen head-of-line blocking.** A per-consumer DynamoDB-stream inbox stalls every profile in the shard when one profile's processing stalls; a FIFO today stalls one `MessageGroupId`. Strict ordering per key would be bought by widening the blast radius.
- **Stream event source mappings retry indefinitely by default.** The FIFO's bounded redrive (3 attempts to a DLQ) is a semantic the replacement has to re-establish explicitly, or the system trades a request bill for a poison message that blocks a shard forever.
- **`m0jc.3` removes half the pollers for free**, so the redesign's payoff shrinks before it is built.
- **The transport seam is already in place** ([event-transport.md](../technical-direction/event-transport.md)), so the swap stays cheap whenever a trigger fires.

## How we might do it

Event delivery that is **pushed, not polled**: a producing component hands work to a consumer without the consumer maintaining a standing receive loop. Delivered capability, not mechanism — an idle system issues no delivery requests at all, while an active system keeps the properties the FIFOs were introduced for: per-key ordering, deduplication of redelivered work, bounded retries, and a dead-letter path.

The redesign is transport-level, not domain-level. The events, their contracts and the ownership boundary stay as they are; what changes is how a domain is woken up when it has work. The current `queue → Lambda event source mapping` arrangement is one implementation of "a delayed void call into a domain", and it is the specific implementation that bills while empty.

Constraints on any replacement:

- **The bar is a $0 at-rest bill, not "inside the SQS free tier".** Staying under 1M requests leaves the cost model intact and the next config change breaches it again.
- **This idea fixes event delivery only.** A literal $0 at rest also needed the four DLQ metric alarms deleted (~$0.40/month idle), which is done; CloudWatch Logs retention persists after activity and is a separate decision.
- Must preserve the domain-event vocabulary and the ownership boundary: producers emit registered events, the consuming domain owns its own surface, and no context reads another's table.
- Must keep a dead-letter and failure path, or replace it with an equivalent signal — silent loss is a worse trade than a request bill.
- Local development and integration tests use LocalStack/Testcontainers, so the replacement must be exercisable there, not only in deployed AWS.

## Revisit triggers

- `m0jc.3` lands — re-measure; the production idle figure should drop by roughly two-thirds, to ~248,000, and what is left may no longer be worth a redesign.
- Measured idle load grows materially above the accepted 724,000/month baseline — a further ~10%, roughly 800,000/month, counts as material.
- Idle load plus real traffic approaches the 1,000,000/month free-tier cap, so the free tier stops absorbing bursts.
- A new SQS consumer is added.

## Priority

Deferred. The standing cost is inside the free tier with room for real traffic, and `m0jc.3` removes half of it without any transport work.

## Notes

- Raised 2026-10-24 after an SQS usage notification of ~850k requests, and deferred the same day once the measurement showed it was idle polling. The baseline to compare against and how to read the audit script's verdict line are in [Auditing idle SQS requests](../ops.md#auditing-idle-sqs-requests).
- Adjacent reading before designing: [event-transport.md](../technical-direction/event-transport.md) (transport seam, ownership boundary, delayed-void-call model) and the three-tier event analysis in [ARCHITECTURE.md](../../ARCHITECTURE.md#events-registry--staging-contracts).
