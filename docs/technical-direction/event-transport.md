# Technical Direction: Event Transport — log-as-bus vs a message bus

**Status:** proposed · **Date:** 2026-09-13 · **Bead:** petroglyph-y5bm.1 · **Context:** PR #113 (petroglyph-j1gn Delivery 1), stop-1 review

**Decision in one line:** keep the DynamoDB event log as both the record and the near-term transport, but make the log an _owned component_ with a narrow read contract and a swappable transport seam — so the bus decision becomes a later, local change instead of a rewrite.

> **Implementation + supersede note (2026-09-19):** move 2's transport seam has landed — `EventSource<WireRecord>` in `packages/events`, with `createDdbStreamEventSource` owning the stream record shape (`petroglyph-y5bm.1.1`, port-only); the transport-seam half of move 2, and the rest of the recommendation, stand. The runtime-registry-introspection half is void (`petroglyph-j1gn.19`): the recommendation to add `listRegistered()` (the vocabulary half of move 2 and the validation plan below) is also void — a runtime registry inside a Lambda bundle can never guarantee completeness. A build-time catalogue to replace it was implemented and then dropped (`petroglyph-6ra.5.2.1.1`, reverted); enumeration is deferred until a cross-context consumer needs it (see [ARCHITECTURE.md](../../ARCHITECTURE.md#events-registry--staging-contracts)). The current-state bullet describing the forwarder as parsing the stream shape is history as of this doc's date.

## Problem and target outcome

Producers currently emit business events by writing a CloudEvent to the `event_log` table with a put-if-absent condition; the table's stream is the fan-out mechanism that carries events to consuming domains. The log is therefore two things at once: the system of record (the dedupe anchor) and the inter-context transport. The stop-1 review flagged that fusion as uncomfortable, with four concrete concerns (mixed roles, over-broad read access, 24-hour stream retention, and DDB stream shape leaking into domain code).

The horizon for this choice is unknown, by the user's own assessment. That makes reversibility the dominant criterion: pick the shape that is cheapest to correct if a second consumer, a least-privilege requirement, or external consumption arrives.

**Target outcome:** events reach consuming domains durably and in order, without the transport choice being cemented by today's implementation.

## Current-state constraints

Gathered from the code, not assumed.

- **The log is durable and permanent.** `event_log` is keyed `source` + `id` with `ConditionExpression: attribute_not_exists(source) AND attribute_not_exists(id)` ([`event-log.ts:31`](https://github.com/jaybeeuu/petroglyph/blob/dd6def6/packages/events/src/event-log.ts)), and has **no TTL** ([`dynamodb.tf:155`](https://github.com/jaybeeuu/petroglyph/blob/dd6def6/packages/infra/dynamodb.tf)). It is the one place dedupe-at-write happens; no AWS bus offers a conditional put, so the log cannot be replaced by a broker.
- **DynamoDB Streams retain 24 hours.** Falling behind yields `TrimmedDataAccessException`; the stream is not a durable per-consumer buffer ([AWS docs](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html)).
- **There is exactly one stream consumer today** — the staging forwarder, with `starting_position = "LATEST"` ([`lambda_staging.tf:128`](https://github.com/jaybeeuu/petroglyph/blob/dd6def6/packages/infra/lambda_staging.tf)). A consumer added later gets no history from the stream; history is a table read.
- **The forwarder hard-codes the event vocabulary and the stream wire shape.** It tries `fileStagedEvent` then `fileDeletedEvent`, and reads `record.dynamodb.NewImage.doc.S` ([`forwarder.ts`](https://github.com/jaybeeuu/petroglyph/blob/dd6def6/packages/staging-consumer/src/forwarder.ts)). The registry exposes no introspection to drive this generically.
- **Read access is whole-log.** A consuming Lambda is granted `GetRecords`/`GetShardIterator`/`DescribeStream`/`ListStreams` on `event_log` and `event_log/stream/*` ([`iam.tf:377`](https://github.com/jaybeeuu/petroglyph/blob/dd6def6/packages/infra/iam.tf)) — every event, every profile, regardless of what the consumer subscribes to.
- **No second cross-context consumer exists yet.** The dispatch consumer (6.5.2.3) is the second half of the _staging_ domain, not a separate context; the next genuine cross-context consumer is Delivery 3 (plugin feed, `petroglyph-m0jc`).
- **EventBridge does accept CloudEvents.** The prior "EventBridge is not native CE" rejection is outdated: `PutEvents` accepts structured CE, and AWS documents the pattern ([AWS blog](https://aws.amazon.com/blogs/compute/sending-and-receiving-cloudevents-with-amazon-eventbridge/)). Targets still receive an EventBridge-shaped envelope around the payload, which is a real friction but not a disqualifier.

**Assumption to test:** the staging index is derivable from the log. If so, the 24-hour stream window is a _latency_ bound on convergence, not a _loss_ bound — the table holds every event forever.

## Options considered

### Option A — The log stream stays the transport, hardened

Keep the log as record and transport. Add (1) a transport seam (enumeration is deliberately deferred — see the note above), (2) a reconciliation pass that converges a lagging consumer from the log, (3) an explicit, documented trust boundary.

**Pros** — Nothing new to operate. Dedupe-at-write stays central. Ordering per profile is already provided by DDB Streams shards + the FIFO queue. Replay is a table read, which is native and unlimited.

**Cons** — The record/transport fusion remains at the data layer; only the contract hides it. Consumers still need stream IAM unless reads also move behind an API (see Recommendation).

**Risks** — A second consumer added without the seam recreates the hard-coded switchboard problem. The 24-hour window can silently stall a consumer if no reconciliation exists.

### Option B — The log is record-only; a bus carries events

Producers keep `putIfAbsent`. A single registry-owned publisher reads the log stream and publishes CE to a bus (SNS FIFO, or EventBridge); each consuming domain subscribes with its own SQS FIFO + DLQ + filter policy.

**Pros** — Clean separation of record and transport. Per-consumer queue scoping and least privilege. Durable per-consumer buffering (SQS retention up to 14 days) with a visible DLQ.

**Cons** — Adds a component and a second at-least-once boundary. Ordering now depends on `MessageGroupId` propagating through the bus (SNS FIFO does propagate it to SQS FIFO; EventBridge rules do not preserve FIFO ordering). Content filtering on SNS needs the CE `type` duplicated into message attributes; EventBridge can filter on `detail-type` but reshapes the envelope.

**Risks** — For one consumer, this is machinery with no passenger. The double-write (log vs publish) needs a defined commit point; publishing from the stream is the safe shape, but it is more moving parts to reason about.

### Option C — EventBridge as the bus, log as a subscriber

Events go to EventBridge first; archive provides replay and the schema registry provides discovery; a persist rule writes to the log for dedupe.

**Pros** — Archive/replay and schema registry are managed. Content-based routing is first-class.

**Cons** — Gives up dedupe-at-write: EventBridge is at-least-once with no conditional put, so consumers must dedupe on every delivery and the log is populated by a subscriber, not the producer. Replay is archive-coarse, not query-native.

**Risks** — The one property that is expensive to buy back (central dedupe) is spent to gain features not yet needed.

## Recommendation

**Option A, hardened — with the log treated as an owned component rather than a shared table.**

1. **Ownership boundary (the load-bearing move).** The service that owns `event_log` exposes reads as an operation — a "read events since checkpoint" call — and no other context reads the table directly. Consumers call the operation; the table's shape becomes an implementation detail. This upgrades A: a consumer's reach is bounded by what the operation returns (addressing the over-broad-access concern) and the record/transport fusion becomes private to the owning component (addressing the mixed-roles concern). Both of those were previously "only a bus fixes this."
2. **Transport seam.** An `EventSource`/`EventTransport` port; move the `NewImage.doc.S` parsing into a `DdbStreamEventSource` adapter. A cross-context consumer needing "all event types" will read a build-time catalogue when one exists; neither exists today, and a runtime registry is rejected (see the note above). This removes the stream wire shape from domain code, and makes Option B a swap of one adapter rather than a migration.
3. **Reconciliation from the log.** A consumer that finds itself behind converges by reading events since its checkpoint through the owned operation and reprocessing them. Consumers already dedupe on `source` + `id`, so replays are safe. This turns the 24-hour window into a latency bound and gives the currently-unused `putIfAbsent` boolean a purpose: reconciliation hits are redelivery telemetry.

**Why not B now.** Its benefits (per-consumer scoping, durable buffers, filter policies) are only realised at more than one consumer, and today there is one, owned by the same domain. Building it now is speculative machinery. The ownership boundary in move 1 captures the least-privilege benefit without the extra component.

**Why not C now.** It spends dedupe-at-write — the property that makes the current design correct under redelivery — for archive and registry features nothing currently needs.

## Tradeoffs accepted

- The record/transport fusion is **hidden, not eliminated**. It remains a property of the owning component; a bus is still the eventual answer if the log's transport responsibilities outgrow the component.
- Whole-log read is acceptable **only because** today's single consumer is same-team and same-domain. The ownership boundary is what makes it safe to defer; without it, this tradeoff would not hold.
- Reconciliation adds a scheduled job and a checkpoint store. The alternative (a bus with durable per-consumer buffers) trades that for a bus to operate.

## Validation plan

Run move 2 alone first, as the cheapest experiment. Extract the port and re-point the forwarder at a `DdbStreamEventSource` adapter.

- **Success signal:** the forwarder no longer parses the stream record shape; it may still name its own domain's event types, because it is a same-domain consumer. That confirms B/C collapse to an adapter swap.
- **Failure signal:** the stream shape leaks in more places than `forwarder.ts`. That would mean the fusion runs deeper than believed and Option B deserves a fresh evaluation rather than deferral.

## Revisit triggers

- A second **cross-context** consumer appears — concretely, before Delivery 3 (`petroglyph-m0jc`).
- A consumer must be _unable_ to read other contexts' events (least privilege becomes mandatory, e.g. an external or third-party consumer).
- Consumer count exceeds roughly three, making per-consumer grants and shared dispatch edits painful.
- Ordering or durability needs exceed what a single stream plus reconciliation provides (strict global order, or sub-second fan-out to many consumers).
- The owning component's read operation grows into a query surface — a sign the log has become a service and the transport should be separated.

## References

- [`packages/events/src/event-log.ts`](https://github.com/jaybeeuu/petroglyph/blob/dd6def6/packages/events/src/event-log.ts) — put-if-absent dedupe contract.
- [`packages/events/src/registry.ts`](https://github.com/jaybeeuu/petroglyph/blob/dd6def6/packages/events/src/registry.ts) — registration binds `type` + `dataschema`; no introspection today.
- [`packages/staging-consumer/src/forwarder.ts`](https://github.com/jaybeeuu/petroglyph/blob/dd6def6/packages/staging-consumer/src/forwarder.ts) — hard-coded vocabulary and stream-record parsing.
- [`packages/infra/dynamodb.tf`](https://github.com/jaybeeuu/petroglyph/blob/dd6def6/packages/infra/dynamodb.tf) — `event_log` table, `NEW_IMAGE` stream, no TTL.
- [`packages/infra/lambda_staging.tf`](https://github.com/jaybeeuu/petroglyph/blob/dd6def6/packages/infra/lambda_staging.tf) — forwarder event source mapping, `starting_position = "LATEST"`.
- [`packages/infra/iam.tf`](https://github.com/jaybeeuu/petroglyph/blob/dd6def6/packages/infra/iam.tf) — whole-log stream read grant.
- [DynamoDB Streams: change data capture](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Streams.html) — 24-hour retention.
- [Sending and receiving CloudEvents with Amazon EventBridge](https://aws.amazon.com/blogs/compute/sending-and-receiving-cloudevents-with-amazon-eventbridge/) — EventBridge CE support.
- [SNS message grouping for FIFO topics](https://docs.aws.amazon.com/sns/latest/dg/fifo-message-grouping.html) — `MessageGroupId` propagation to SQS FIFO.
- [ARCHITECTURE.md — Events Registry & Staging Contracts](../../ARCHITECTURE.md#events-registry--staging-contracts) — domain events and the consumer-forwarded principle (redesign §3).
- [`packages/events/README.md`](../../packages/events/README.md) — CloudEvents envelope and attribute mapping (redesign §4).
- Redesign note §8 (Q8 registry transport) has no tracked home yet; it remains untranslated scratch in `.working-docs/6ra.5-redesign-decisions.md`.
