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

## Committed schema artifacts

`schemas/` is the generated record of the registered event contracts: one draft-2020-12 JSON Schema
per event, payload-only, with `$id` set to the event's `dataschema` URI and the file path mirroring
that URI (`https://schemas.petroglyph.dev/file-staged/v1.json` -> `schemas/file-staged/v1.json`).
They are generated — never hand-edited — by
[`@petroglyph/event-catalogue`](../event-catalogue/README.md), which also generates the dispatch
table consumers use. The `event-catalogue` CI job regenerates and diffs them, so the committed
schemas cannot drift from the declarations.

## Conventions

A **tier-1 (registered domain) event** must conform to the CloudEvents 1.0.2 structured envelope.
Name events after facts, in the past tense — an event says what happened, never what to do. The
envelope is one JSON object as the message body, with these attributes:

| Attribute         | Value                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `specversion`     | `"1.0"`                                                                  | CloudEvents 1.0.2, structured content mode, JSON format.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `type`            | `petroglyph.<domain>.<fact>`                                             | Brand-anchored and permanent, e.g. `petroglyph.file.staged`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `source`          | The producing context, e.g. `onedrive://profiles/<profileId>`            | The envelope `source` is not the business `source` tag — the latter (`onedrive`) lives inside `data`, where it is unambiguous.                                                                                                                                                                                                                                                                                                                                            |
| `id`              | Unique within `source`                                                   | `source` + `id` is the idempotency anchor. `id` is required and producer-supplied — `registerEvent` deliberately does not generate one, because a random default would silently defeat the anchor rather than fail. Producers use deterministic ids (`<profileId>:<itemId>:<changeType>`), so a re-send for the same logical event may repeat `source` + `id`: the log's put-if-absent condition suppresses the duplicate write, and consumers dedupe on the same anchor. |
| `subject`         | The object the event is about, e.g. `files/<itemId>`                     | Optional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `time`            | RFC3339 UTC timestamp, e.g. `2026-09-03T12:00:00Z`                       | Producers must be consistent per `source`.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `datacontenttype` | `application/json`                                                       | Defaulted by the envelope schema.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `dataschema`      | Versioned URI, e.g. `https://schemas.petroglyph.dev/file-staged/v1.json` | An incompatible payload change is a **new URI**; evolution is additive.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `data`            | The business payload                                                     | The payload schema is registered with the event and lives with its domain.                                                                                                                                                                                                                                                                                                                                                                                                |

Using `registerEvent` is the recommended way to guarantee conformance; it is not mandated — the
standard is the contract, not the function.

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
