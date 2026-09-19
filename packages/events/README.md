# @petroglyph/events

The central event registry: CloudEvents 1.0.2 envelope machinery shared by every producer and
consumer, plus the event-log transport. It holds **no domain vocabulary** — registered events live
with their domain (today, `packages/staging-contracts`). For the taxonomy and why it exists, see
[ARCHITECTURE.md](../../ARCHITECTURE.md#events-registry--staging-contracts).

## What it provides

- `registerEvent({ type, dataschema, dataSchema })` — binds a payload zod schema to the CE
  envelope; returns `buildDocument`, `parse`, `format`, and `jsonSchema`.
- `cloudEventSchema`, `parseCloudEvent`, `formatCloudEvent` — the raw envelope.
- `createEventLogWriter` — the event-log transport (put-if-absent on `source` + `id`).
- `EventSource<WireRecord>` — the transport port a consumer reads log rows through; each transport
  supplies the wire shape in its own adapter.

## Conventions

A **tier-1 (registered domain) event** must conform to the CloudEvents 1.0.2 structured envelope
and the rules below. Using `registerEvent` is the recommended way to guarantee that conformance; it
is not mandated — the standard is the contract, not the function.

- **Name facts, in the past tense.** An event says what happened, never what to do.
- **`type` is `petroglyph.<domain>.<fact>`.** Brand-anchored and permanent, e.g.
  `petroglyph.file.staged`.
- **`dataschema` is a versioned URI**, e.g. `https://schemas.petroglyph.dev/file-staged/v1.json`.
  An incompatible payload change is a **new URI**; evolution is additive.
- **`source` + `id` is the idempotency anchor.** `id` is required and producer-supplied —
  `registerEvent` deliberately does not generate one, because a random default would silently
  defeat the anchor rather than fail. Event ids are deterministic
  (`<profileId>:<itemId>:<changeType>`), so redeliveries and restages dedupe at the log write.
- **`time` is an RFC3339 UTC timestamp.**
- **The envelope `source` attribute is not the business `source` tag.** The former identifies the
  producing context (`onedrive://profiles/<profileId>`); the latter (`onedrive`) lives inside
  `data`, where it is unambiguous.

Only tier-1 events are registered. Adapter-internal facts and queue-internal messages are never
registered — see the three-tier taxonomy in ARCHITECTURE.md.

## Reading the log

Consumers receive events through their own queue, fed from the log's stream. The consumer reads rows
through the `EventSource` port, so the stream's wire shape stays in its adapter
(`createDdbStreamEventSource`) rather than leaking into consuming domain code. **Historical reads —
bootstrap and reconciliation — go through the operation owned by the service that owns `event_log`,
not a direct table scan.** That keeps the table's shape free to change without changing the
consumer contract. See the ownership boundary in
[docs/technical-direction/event-transport.md](../../docs/technical-direction/event-transport.md).
