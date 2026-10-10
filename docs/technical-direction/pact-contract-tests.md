# Technical Direction: Cross-Service Contract Coverage — why there is no dedicated contract-test suite

**Status:** accepted · **Date:** 2026-10-09 · **Bead:** petroglyph-up9y.1.4 · **Context:** verification model for the Delivery 1 pipeline

**Decision in one line:** the cross-service payload contract is pinned by the shared `@petroglyph/staging-contracts` zod schemas plus repo-wide typecheck, which fail drift in the same commit; do **not** build a separate contract-test package, and do **not** adopt `@pact-foundation/pact`. Revisit only if a consumer becomes independently deployed.

## Problem and target outcome

The delivery pipeline crosses several service boundaries: the ingest adapter emits a CloudEvent document that the streams forwarder reads from the DynamoDB stream and forwards as a queue message, and the message is applied to the index and surfaced through the delivery read model. A guard must fail when a producer and a consumer disagree about a payload crossing one of those boundaries.

**Target outcome:** the cheapest reliable drift signal at those boundaries, without adding an external service or Docker to CI, and a decision on whether that signal needs a dedicated suite — Pact or home-grown.

## Current-state constraints

Gathered from the code and CI, not assumed.

- **The contract is a shared zod schema, in one repo.** Producers and consumers both import `@petroglyph/staging-contracts` — `fileStagedEvent` / `fileDeletedEvent` bind the CloudEvent envelope to `fileStagedDataSchema` / `fileDeletedDataSchema` ([`staging-contracts/src/events.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/staging-contracts/src/events.ts)). A field rename in the producer fails the consumer's parse, and `pnpm -r typecheck`, in the **same commit**.
- **Both sides build and deploy atomically.** `ingest-onedrive` and `staging-consumer` are packages in one pnpm workspace, tested together by `pnpm -r test`, shipped from one `main`. There is no version skew to reconcile between them.
- **The runtime is Lambda → DynamoDB Streams → SQS FIFO → index, not HTTP.** The cross-service boundaries carry asynchronous messages; the index apply and the DDB read model are in-process ([`forwarder.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/staging-consumer/src/forwarder.ts), [`ddb-stream-event-source.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/staging-consumer/src/ddb-stream-event-source.ts)).
- **CI must run with no external services and no Docker.** Any contract suite would have to be a pure, test-only package.
- **There is no Pact Broker.** Introducing a hosted PactFlow or self-hosted broker would add an external service the CI constraint excludes.
- **The one independently deployed consumer is the Obsidian plugin.** It ships to users' vaults on its own cadence and talks to the API over HTTP; old plugin versions meet new APIs. The pipeline boundaries are not that.

## Options considered

### Chosen — shared schema + typecheck, no dedicated suite

Rely on the single-sourced zod schema and the workspace typecheck to catch drift where it is introduced. The service-boundary tests (real handlers against LocalStack) exercise the payload end to end; no contract-specific package is created.

**Pros** — No new dependency and no new package. Drift fails `pnpm -r typecheck` / `pnpm -r test` in the same commit that introduces it. The contract stays single-sourced in zod, consistent with the repo's "zod is the single validation library" rule, and there is no second schema to keep in step.

**Cons** — No dedicated artifact asserting the round-trip; the guarantee rests on both sides importing the shared schema, plus the boundary tests where they exist.

**Risks** — If a producer stops importing the shared schema and hand-builds a payload, typecheck cannot see the divergence; only a boundary test would. That is the signal to reconsider a dedicated suite.

### Rejected — home-grown pure round-trips

A test-only `packages/contract-tests` package driving the real producer and consumer functions with in-memory transports, no Docker.

**Pros** — An explicit producer→consumer round-trip that fails on drift in the same commit, with no new dependency and no Docker.

**Cons** — Duplicates what the shared schema plus typecheck already guarantee for atomically deployed sides; another package and test surface to maintain for no additional failure mode.

**Risks** — None material inside the monorepo; the model is weaker only if a boundary becomes independently deployed.

### Rejected — Pact, file-based

Add `@pact-foundation/pact` to a contract-test package; write consumer message pacts for the forwarder and provider verification against the real emitter; share pacts as files (`pactUrls`), no broker.

**Pros** — A portable, consumer-owned contract artifact. Consumer-driven subset (asserts only the fields the consumer reads). Provider states. Transport-agnostic async-message support.

**Cons** — A second description of the contract (matchers) kept in step with the zod schema. A platform-specific native prebuild (`@pact-foundation/pact-core`, ~18 MB) plus ~169 install packages, and an arch/glibc coupling for CI. Every differentiator that would justify the cost — consumer versioning, `can-i-deploy`, pending/WIP pacts — requires a broker, which is out of bounds. For atomically deployed sides, the artifact carries no information the shared schema does not.

**Risks** — Contract drift between the zod schema and the Pact matchers; a Pact core/vitest upgrade treadmill; CI runner architecture coupling.

## Recommendation

**Adopt the shared schema + typecheck, and build no dedicated contract suite.** Keep the cross-service contract single-sourced in zod. Record that both Pact and a home-grown round-trip suite were evaluated and deliberately not built, with the plugin↔API boundary named as the trigger that would reopen the question.

**Why not the home-grown suite.** The drift signal it would add — a producer rename failing a consumer test — is already produced by typecheck in the same commit for atomically deployed packages. The package would add maintenance surface for no new failure mode.

**Why not Pact.** Pact is feasible and correct, but it is a parallel copy of the contract plus a native dependency. Its differentiating features are broker-gated and the broker is excluded by the CI constraint. Adopting it pays the cost before the problem it solves exists.

## Tradeoffs accepted

- **No dedicated drift stage.** Drift is caught by the shared schema and typecheck rather than a named suite. Acceptable because both sides import the one schema and deploy atomically; the signal and the fix are in the same commit.
- **No portable artifact / no `can-i-deploy`.** Accepted because no boundary is independently deployed today. A consumer-driven contract buys this back when it is needed.
- **Revisit, not eliminated.** The contract remains single-sourced in a package that is deliberately compatible with adding a dedicated suite later, at one or more boundaries.

## Validation plan

A throwaway Pact prototype was built and run for this decision (node 24, vitest 3.2.4, pact-js 17.1.4, pact-core 20.2.0), exercising the real producer and consumer over in-memory transports:

1. **Consumer** — Pact generated a CloudEvent and passed it to the real `forwardStreamRecords` + `createDdbStreamEventSource` over in-memory transports: **pass**; wrote `pacts/staging-consumer-ingest-onedrive.json` (async message, matchers, provider state).
2. **Provider** — `MessageProviderPact` called the real `emitFileStaged` and verified the produced document: **pass**.
3. **Drift** — renaming `data.s3Key → data.key` in the produced document made verification fail with `$.data -> Actual map is missing the following keys: s3Key`: **fail as required**.
4. **Broker/Docker** — steps 1–3 ran with no broker and no Docker; file-based `pactUrls` only.

**Success signal for the chosen option:** changing a producer payload without the matching consumer change fails `pnpm -r typecheck` (or `pnpm -r test`) in the same commit, with no new dependency or suite. The boundary tests ([`event-log.integration.test.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/events/src/event-log.integration.test.ts), [`delivery.integration.test.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/staging-delivery/src/delivery.integration.test.ts)) exercise the payload end to end against LocalStack.

**Failure signal that reopens a dedicated suite:** a boundary becomes independently deployed (producer and consumer version skews), a consumer must be unable to see the full schema, or a producer hand-builds a payload instead of importing the shared schema — at which point the shared-schema gate no longer covers the boundary.

## Revisit triggers

- The Obsidian plugin and the API break each other across releases (independent release cadence becomes a real failure mode) — the strongest signal, and the starting line for a consumer-driven suite.
- A producer or consumer moves out of this repo / onto its own deploy pipeline, so atomic co-change is lost.
- A producer hand-builds a payload instead of importing `@petroglyph/staging-contracts`.
- A second consumer must be protected from regressions to the first, making versioned contracts valuable.
- A Pact Broker (PactFlow or self-hosted) becomes acceptable infrastructure and cross-version compatibility becomes a release gate.

## References

- [`packages/staging-contracts/src/events.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/staging-contracts/src/events.ts) — the shared zod event contract.
- [`packages/ingest-onedrive/src/land/emit.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/ingest-onedrive/src/land/emit.ts) — the event producer.
- [`packages/staging-consumer/src/forwarder.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/staging-consumer/src/forwarder.ts) — the stream→queue consumer.
- [`packages/staging-consumer/src/ddb-stream-event-source.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/staging-consumer/src/ddb-stream-event-source.ts) — the stream read seam.
- [`packages/events/src/event-log.integration.test.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/events/src/event-log.integration.test.ts) · [`packages/staging-delivery/src/delivery.integration.test.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/staging-delivery/src/delivery.integration.test.ts) — the LocalStack boundary tests that exercise the payload.
- [`docs/testing.md`](../testing.md) — test levels and the Docker policy.
- [`docs/technical-direction/event-transport.md`](event-transport.md) — related transport-seam decision.
- [Pact async messages](https://docs.pact.io/implementation_guides/javascript/docs/messages) · [Pact provider verification](https://docs.pact.io/implementation_guides/javascript/docs/provider) · [Pact without a broker](https://docs.pact.io/pact_broker).
