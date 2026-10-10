# Technical Direction: Verification strategy — component, boundary, contract, deployed

**Status:** accepted · **Date:** 2026-10-06 · **Beads:** petroglyph-up9y (epic), .1–.5 · **Gate:** petroglyph-j1gn.52
**Context:** Delivery 1 (petroglyph-j1gn) landed as ten chunk PRs through #166; the acceptance gate is the wired path on `main`.

**Decision in one line:** verify in three layers — component, service boundary, and a deterministic deployed smoke against a persistent QA environment — and make the deployed smoke gate production promotion; the cross-service payload contract is pinned by the shared zod schema and typecheck rather than a dedicated suite; live-Microsoft-Graph checks stay opt-in and never gate.

## Problem and target outcome

Delivery 1 is on `main`, but the only acceptance gate left (`petroglyph-j1gn.52`) asks for proof of the wired path, and the durable verification story beyond that gate is unset. The open question was whether a single in-process cross-component LocalStack test proves the pipeline.

It does not, by itself. That test hand-wires the composition roots the deployment owns, so it can stay green while the deployed path is broken. The target is a model where each failure localises to the layer that owns it and no test claims more than it proves.

## Current-state constraints

Gathered from the code.

- **CI is the only truth.** Validation runs build, format, lint, typecheck, and test (`.github/workflows/validate.yml`). Docker is a hard requirement; integration suites fail rather than skip ([docs/testing.md](../testing.md)).
- **The existing integration suites exercise libraries, not deployed handlers.** `processChange`, `applyStaged`, and the Hono router are driven directly; the handler shells and composition roots (`buildDeltaRunner`, `createAdapterHandler`, `createForwarderHandler`) are largely tested with mocked dependencies.
- **The cross-service contract already exists as code.** `fileStagedEvent`/`fileDeletedEvent` ([`staging-contracts/src/events.ts`](../../packages/staging-contracts/src/events.ts)) are used by the producer ([`ingest-onedrive/src/land/emit.ts`](../../packages/ingest-onedrive/src/land/emit.ts)) and re-parsed by the consumer ([`staging-consumer/src/forwarder.ts`](../../packages/staging-consumer/src/forwarder.ts)). Drift fails `pnpm -r typecheck` in the same commit, so no separate contract suite is needed ([pact-contract-tests.md](pact-contract-tests.md)).
- **Microsoft Graph has no emulator.** The adapter reads `GRAPH_BASE_URL` ([`lambda_staging.tf`](../../packages/infra/lambda_staging.tf)), so a deployed run can be pointed at a stub.
- **A missing component is invisible to LocalStack.** The `staged_events` FIFO queue has no deployed consumer (`6ra.5.2.3`, Delivery 2). Only a deployed run can observe that.
- **The infrastructure is one `production` workspace.** Resource names are workspace-suffixed, but SSM parameter names are global (`/petroglyph/...`, [`ssm.tf`](../../packages/infra/ssm.tf)) and the deploy role trusts `environment:production` ([`bootstrap.sh`](../../packages/infra/scripts/bootstrap.sh)). The deploy pipeline is single-environment and runs on push to `main`.

## Options considered

### Option A — one in-process cross-component LocalStack test

Wire `runDeltaSync` → LocalStack S3/DDB/Streams/SQS → `applyStaged` → the `/files` router in one process.

Pros: a single artifact; deterministic; no deployment. Cons: it duplicates the composition roots, so it can pass while the deployed path is broken; it is neither a component test nor a true e2e. Risks: being mistaken for proof of the wired path.

### Option B — three layers

Component (exists) → boundary (real handler + realistic trigger against LocalStack) → deterministic deployed smoke against a persistent QA environment, gating production promotion. Cross-service drift is pinned by the shared zod schema and typecheck, not a dedicated contract suite.

Pros: each failure localises; the deployed layer is the only one that catches env, IAM, routing, and missing-component faults; the shared schema catches drift cheapest. Cons: more artifacts; a QA environment to stand up. Risks: QA drift; slower boundary tests.

### Option C — B plus consumer-driven contracts and ephemeral per-PR environments

Add Pact-style contract tooling and per-PR ephemeral environments so the deployed smoke gates PRs.

Pros: the strongest PR gating. Cons: CDC is heavyweight for a monorepo that already shares schemas; ephemeral destroy automation is weeks of work and needs an owner. Deferred: Option B makes it a config change later.

## Recommendation

**Adopt B.**

1. **Component** — unchanged.
2. **Boundary** — drive each deployed handler with a realistic trigger against LocalStack: adapter (`SQSEvent`), forwarder (`DynamoDBStreamEvent`), delivery (API Gateway event).
3. **Deployed smoke** — deterministic, Graph mocked via `GRAPH_BASE_URL`, run against a persistent QA environment.

The deploy pipeline promotes through QA: build → package → deploy QA → smoke → deploy production. A failed smoke blocks production. Live Graph is a separate, opt-in, never-scheduled suite.

**Why not A:** it hand-wires the composition roots, so it is the one artifact that can be green while the system is broken, and it is not the evidence the gate needs — the missing consumer would still be invisible. **Why not C now:** the cost is not justified until PR-level deployed gating is required; B leaves the door open.

## Tradeoffs accepted

- A persistent QA environment to maintain: SSM names must be namespaced and the deploy-role trust extended. Real infra work.
- No dedicated contract suite: the shared zod schema plus `pnpm -r typecheck` is the drift gate, so a producer→consumer round-trip package would duplicate the contract for no additional failure mode.
- The deployed smoke mocks Graph, so it proves our path, not Microsoft's. Live Graph stays an occasional manual check.
- Until the QA smoke exists, the deployed proof for `j1gn.52` is a human run-through, and the missing `staged_events` consumer is visible only there.

## Validation plan

- **First (cheapest):** confirm the shared-schema gate. Success = changing a producer payload without the matching consumer change fails `pnpm -r typecheck` in the same commit. Failure = the seam is not as clean as believed and the boundary belongs lower.
- **Then:** boundary tests per service. Success = a real handler with real LocalStack side effects. Failure = handlers cannot be exercised without a Lambda runtime, which pushes weight onto the deployed smoke.
- **Then:** QA workspace apply and smoke. Success = the smoke is green on merge and blocks a deliberately broken build. Failure = destroy/drift flakiness, which argues for ephemeral.

## Revisit triggers

- PR-level deployed gating becomes required — build ephemeral environments (Option C).
- A second or external consumer appears — reconsider consumer-driven contract tooling.
- Live Graph proves too flaky even for an opt-in suite — drop it.
- QA drift exceeds its value — prefer ephemeral over a persistent tier.

## References

- [pact-contract-tests.md](pact-contract-tests.md) — why the cross-service contract has no dedicated test suite.
- [docs/testing.md](../testing.md) — the current test layers and the Docker mandate.
- [`packages/staging-contracts/src/events.ts`](../../packages/staging-contracts/src/events.ts) — the cross-service payload schemas.
- [`packages/ingest-onedrive/src/land/emit.ts`](../../packages/ingest-onedrive/src/land/emit.ts) — the producer.
- [`packages/staging-consumer/src/forwarder.ts`](../../packages/staging-consumer/src/forwarder.ts) — the consumer.
- [`packages/infra/lambda_staging.tf`](../../packages/infra/lambda_staging.tf) — adapter `GRAPH_BASE_URL`; forwarder event-source mapping.
- [`packages/infra/ssm.tf`](../../packages/infra/ssm.tf) — global SSM parameter names.
- [`packages/infra/scripts/bootstrap.sh`](../../packages/infra/scripts/bootstrap.sh) — deploy-role trust (`environment:production`).
- [`.github/workflows/deploy.yml`](../../.github/workflows/deploy.yml) — single-environment deploy.
