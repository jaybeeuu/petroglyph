# Technical Direction: QA Environment and Deployed Smoke

**Status:** accepted · **Date:** 2026-10-11 · **Bead:** petroglyph-up9y.6 · **Implemented:** QA workspace `petroglyph-up9y.3`, deployed smoke `petroglyph-up9y.4` · **Context:** the third layer of the verification model ([verification-strategy.md](verification-strategy.md))

**Decision in one line:** stand up a persistent **QA** Terraform workspace and gate production promotion on a deterministic **deployed smoke** that drives the real wired path with only Microsoft Graph stubbed; namespace every SSM parameter by environment (migrating production by a scripted copy) and give QA its own GitHub environment and deploy role.

## Problem and target outcome

- The verification model has three layers — component, service boundary, and a deterministic deployed smoke ([verification-strategy.md](verification-strategy.md)). The first two are in place; the third has no home.
- Deployed wiring — Lambda env vars, IAM, API Gateway routing, a missing event-source mapping — is invisible to LocalStack. The only deployed proof today is a one-shot human run-through (`petroglyph-j1gn.52`), which proves the path once and then rots.
- **Target outcome:** a repeatable, deterministic smoke that runs against a non-production tier on every merge and blocks production promotion when it fails — without adding an external dependency to the PR-gated CI (that stays LocalStack + mocked seams).
- **Cost outcome:** the QA tier must cost nothing at rest — no standing charge for an idle environment. SQS polling is the one thing that would bill while idle, so QA's four event source mappings are quiesced outside CI runs ([Cost at rest](#cost-at-rest)).
- **Decision horizon:** until a boundary becomes independently deployed or a release cadence splits QA from production (see [Revisit triggers](#revisit-triggers), and [pact-contract-tests.md](pact-contract-tests.md) for the same fork).

## Current-state constraints

Evidence from the code, not assumptions.

- **One environment.** Both CD ([`.github/workflows/deploy.yml`](https://github.com/jaybeeuu/petroglyph/blob/main/.github/workflows/deploy.yml)) and the PR plan ([`.github/workflows/terraform.yml`](https://github.com/jaybeeuu/petroglyph/blob/main/.github/workflows/terraform.yml)) hardcode `terraform workspace select production`. The S3 backend key is `petroglyph/terraform.tfstate`; workspaces already namespace state.
- **Naming is consistent except for SSM.** Every resource is `petroglyph-<thing>-${terraform.workspace}` (DynamoDB, S3, API Gateway, log groups, IAM resource ARNs) — but **14 SSM parameters are pinned at global `/petroglyph/…` names** ([`ssm.tf`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/infra/ssm.tf)). They carry an `environment` tag but are not _named_ by it, so two workspaces would fight over the same parameters.
- **The SSM values are hand-entered SecureStrings.** Terraform writes `PLACEHOLDER` with `lifecycle { ignore_changes = [value] }`; the real values are stored by hand ([`docs/ops.md`](../ops.md)). `aws_ssm_parameter.name` is ForceNew, so a rename destroys and recreates the parameter — **the stored secret is lost** unless it is copied first.
- **SSM paths are already env-var-driven, which softens the rename.** Terraform sets `*_SSM_PATH = aws_ssm_parameter.X.name` ([`lambda_api.tf`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/infra/lambda_api.tf), [`lambda_staging.tf`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/infra/lambda_staging.tf)); the code reads the env var with a hardcoded `/petroglyph/…` fallback ([`ingest-onedrive/src/lambda.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/ingest-onedrive/src/lambda.ts), [`api/src/jwt.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/api/src/jwt.ts), [`staging-delivery/src/jwt.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/staging-delivery/src/jwt.ts)). A Terraform rename flows through automatically; only the fallback defaults and [`api/src/index.test.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/api/src/index.test.ts) hold literals.
- **The Graph seam already exists.** The adapter reads `GRAPH_BASE_URL`, so a deployed run can be pointed at a stub ([`lambda_staging.tf`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/infra/lambda_staging.tf), [`ingest-onedrive/src/lambda.ts`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/ingest-onedrive/src/lambda.ts)). But `GRAPH_DRIVE_ROOT_DELTA_URL` is a **hardcoded literal**, not a var, so it must become environment-derived.
- **The custom domain is already optional.** `var.api_custom_domain = ""` disables the ACM/domain resources ([`custom_domain.tf`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/infra/custom_domain.tf)), so QA can use the raw `execute-api` URL with no new work.
- **Deploy-policy guardrails.** The deploy policy is explicit-action-only and `bootstrap.sh` is its source of truth; **any new AWS resource must extend `bootstrap.sh` in the same change** ([`docs/ops.md`](../ops.md)). Its SSM statement already grants `parameter/petroglyph/*`, so namespaced paths are covered; the read-only plan role's `PlanTimeParameterRead` is scoped to the exact old path and must move.
- **The `production` environment is main-only and has no approval gate** — the PR merge _is_ the deploy gate. A QA tier inserts a job, not a human.
- **No smoke home exists.** `packages/e2e-tests` does not exist; the only deployed check is `pnpm --filter @petroglyph/api smoke-test` in CD.
- **The stack is serverless end to end, which makes idle cheap.** DynamoDB is `PAY_PER_REQUEST` with no PITR, and Lambda, SQS, and API Gateway are pay-per-use; there is no VPC, NAT gateway, RDS, ALB, Route 53 zone, Secrets Manager secret, or customer-managed KMS key anywhere in [`packages/infra`](https://github.com/jaybeeuu/petroglyph/tree/main/packages/infra). The four CloudWatch DLQ alarms that used to be the only standing charge in the stack have been deleted, because they carried no `alarm_actions` and notified nobody — see [Observability](../../ARCHITECTURE.md#observability).
- **Unknowns / risks:** the wall-clock and cost of a second `terraform apply` on every merge; the eventual surface area of the Graph stub once the smoke journey is written; and the one-time prod SSM migration window (below).

## Options considered

### Option A — no QA tier: deepen LocalStack, keep the human run-through

Keep the single production environment; raise LocalStack fidelity and rely on the manual `j1gn.52` run-through for deployed proof.

- **Pros** — No new infrastructure, no migration, no second deploy cost. Nothing to keep in step.
- **Cons** — Deployed wiring stays unverified between manual runs; a broken env var or missing event-source mapping ships to production and is found by a human, late. The run-through is not repeatable.
- **Risks** — LocalStack cannot model real Lambda runtime, IAM, or API Gateway routing, so this layer's blind spot never closes.

### Option B — persistent QA workspace + deterministic deployed smoke (chosen)

Add a `qa` Terraform workspace and a `qa` GitHub environment; on every merge, deploy QA, run a deterministic cross-service smoke with only Microsoft Graph stubbed, and gate the production deploy on it.

- **Pros** — Turns the one-shot deployed proof into a repeatable gate; catches env/IAM/routing/missing-component faults that no LocalStack test can; reuses the same build artifacts; the smoke is deterministic, so it can gate.
- **Cons** — A persistent tier to maintain; a second `terraform apply` per merge; a Graph stub to build; the prod SSM migration below.
- **Risks** — QA drift (a workspace left partly applied); stub fidelity (the smoke passes against a stub that does not match real Graph); deploy-time cost.

### Option C — ephemeral per-PR environments

Spin up a throwaway stack per pull request, smoke it, tear it down.

- **Pros** — Strong isolation; runs before merge; no persistent drift.
- **Cons** — Highest cost and complexity: per-PR apply/destroy, state and credential churn, and a full stack per open PR. No PR-gated CI external services are wanted either.
- **Risks** — Destroy/drift flakiness and cost make it hard to keep reliable; this is `petroglyph-up9y.5`, deliberately deferred.

## Recommendation

**Adopt Option B**, with these sub-decisions. Each was chosen over its alternative for a stated reason.

- **SSM — namespace all parameters, migrate production by a scripted copy.** Move every parameter to `/petroglyph/<workspace>/…`. Because the values are hand-entered SecureStrings, a one-time HITL script run as the admin identity snapshots the existing `/petroglyph/…` values, applies the rename, and restores them to `/petroglyph/production/…` — so no secret is re-keyed by hand.
  - _Rejected: namespace non-production only._ Leaves production as a permanent exception to the naming convention every other resource follows, and leaves the code's fallback defaults wrong for every environment. Rejected: **hand re-entry** — avoidable risk of a production outage on a typo.
- **Trust — per-environment deploy roles.** `bootstrap.sh` creates `petroglyph-github-actions-deploy-qa` (trusting `environment:qa`) alongside the production role, each trusting only its own GitHub environment. This mirrors the existing read-only plan role, which is already environment-pinned.
  - _Rejected: one role trusted for both environments._ A QA job could then assume the production deploy role; the isolation the plan role already has would be given up for less bootstrap.
- **Graph stub — a deployed stub in the QA workspace.** A small stub service (Lambda + function URL) lives in the QA workspace; `GRAPH_BASE_URL` and the delta URL point at it. The smoke exercises the real HTTP path through a real Lambda. The stub serves the drive delta page, item content, and subscription lifecycle, but **not** the OAuth token endpoint: the smoke seeds an unexpired access token in the token vault, so the adapter never calls `login.microsoftonline.com` and no refresh flow is exercised.
  - _Rejected: runner-local mock + tunnel._ A deployed Lambda cannot reach a CI-local server without a tunnel; adds fragile networking. **Rejected: live Graph** — non-deterministic and destructive, so it cannot gate (it stays the separate opt-in tier).
- **Cadence — QA on every merge, gating production.** `build → package → deploy QA → smoke → deploy production`; a failed smoke blocks the production job. This is what makes the smoke a _gate_ rather than a report. Deploys are serialised by a workflow-wide `concurrency` group, so a burst of merges collapses onto the newest commit: the smoke always runs against the stack that is about to be promoted, never against one a concurrent run has already overwritten.
  - _Rejected: on-demand QA smoke_ — a gate that does not run on a merge cannot block it. **Rejected: production on tag** — reintroduces a release step the project does not have.
- **Workspace and state — a new `qa` Terraform workspace in the same S3 backend.** Workspaces already namespace state; no second bucket or key.
- **Environments — GitHub environments `qa`, `production`, and the existing `terraform-plan`**, each holding its own `AWS_ROLE_ARN`. `production` stays main-only.
- **Smoke home — a new `packages/e2e-tests`** package that drives the QA URL set, invoked as a step in the QA deploy job.
- **Stub home — a new package** deployed in the QA workspace (name to be settled in `up9y.3`).
- **Cost — zero standing cost at rest.** The four CloudWatch DLQ metric alarms were gated to `production`, so the QA workspace copied none of them; they have since been deleted outright ([Observability](../../ARCHITECTURE.md#observability)). The four SQS event source mappings are the only remaining idle cost, and `var.qa_quiesced` disables them between CI runs ([Cost at rest](#cost-at-rest)).

## Tradeoffs accepted

- **A second `apply` and a persistent tier on every merge.** Accepted: it is the price of a repeatable deployed gate; Option C is deferred because the cost is not yet justified.
- **No alerting, to hold the standing cost at zero.** The four DLQ alarms were production-only while they existed and have since been deleted, so neither workspace alerts on a DLQ. QA keeps the DLQ queues, so the smoke still exercises the failure path; nothing reports it, and [Checking for stuck messages](../../docs/ops.md#checking-for-stuck-messages) is the manual substitute.
- **A stub, not real Graph.** The smoke proves deployed _wiring_, not Microsoft behaviour; real-Graph behaviour stays the separate opt-in tier and never gates.
- **A one-time production SSM migration window.** During the scripted copy the parameters are briefly absent; the operation is scheduled, admin-run, and reversible from the snapshot.
- **QA drift is possible.** A partly-applied workspace can rot; the smoke running on every merge is the mitigation.

## Cost at rest

Audit of what a `qa` workspace provisions, at idle (region `eu-west-2`):

| Resource                                 | Count | Billing                                            | Idle cost                                                        |
| ---------------------------------------- | ----- | -------------------------------------------------- | ---------------------------------------------------------------- |
| DynamoDB tables                          | 10    | `PAY_PER_REQUEST`, no PITR                         | $0                                                               |
| Lambda functions (incl. stub)            | 9     | per-invoke                                         | $0                                                               |
| API Gateway HTTP API + function URLs     | 1–2   | per-request                                        | $0                                                               |
| SQS queues (standard + FIFO)             | 6     | per-request, **empty long-poll receives included** | $0 — the four event source mappings are quiesced between CI runs |
| S3 bucket (`AES256`)                     | 1     | storage only; lifecycle expiry                     | $0                                                               |
| SSM parameters (standard `SecureString`) | 14    | standard tier is free                              | $0                                                               |
| CloudWatch log groups (14-day retention) | 9     | per ingested byte                                  | ~$0                                                              |
| IAM roles and policies                   | ~8    | free                                               | $0                                                               |

**Aggregate: $0 at rest — because the four SQS event source mappings are disabled whenever CI is not running.** A queue bills on receives, and a poller long-polls an empty queue, so the mappings are the one thing in this table that would carry a cost by existing rather than by being used: QA's four queues account for 213,641 of the 937,587 empty receives measured in the 30 days to 2026-10-24, and `var.qa_quiesced` (default `true`, applied by the `quiesce-qa` job) is what brings them to zero ([QA quiesce](../ops.md#qa-quiesce-sqs-event-source-mappings)). Per-run usage — one smoke invocation set — is pennies, and CI is free because the repository is public. The classic standing-charge traps (NAT gateway, RDS, ALB, customer-managed KMS) are absent because the stack is serverless end to end.

## Validation plan

Fastest de-risking order:

1. **SSM migration spike** — run the snapshot/restore against a scratch workspace first; success = parameters land namespaced with values intact and the adapter still reads them. Failure = the copy cannot be made safe, which forces the non-prod-only namespace.
2. **QA workspace apply/destroy** — success = a clean apply and destroy with no production impact. Failure = hidden global names (notably SSM) that the audit missed.
3. **Stub reachability** — the deployed adapter resolves `GRAPH_BASE_URL` to the stub and completes a delta + content call. Failure = the delta URL is not fully env-derived, or IAM blocks the call.
4. **Smoke gate** — a deliberately broken build fails the smoke and blocks the production job. Failure = the smoke is non-deterministic, which argues for narrowing it to the stable AWS path.

**Success signal for the whole decision:** on a merge, production is promoted only after the QA smoke is green; a broken env var is caught before production.
**Failure signal:** the smoke is flaky or the QA tier drifts faster than it is exercised — reopen Option C.

## Revisit triggers

- QA drifts faster than it is exercised, or the second apply per merge costs more than the gate is worth — prefer ephemeral (Option C / `petroglyph-up9y.5`).
- A boundary becomes independently deployed, so QA and production need version skew.
- Real-Graph behaviour becomes gating rather than opt-in.
- A second consumer or a release cadence appears that a single QA tier cannot represent.

## References

- [`docs/technical-direction/verification-strategy.md`](verification-strategy.md) — the three-layer model this implements.
- [`packages/infra/ssm.tf`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/infra/ssm.tf) — the 14 globally-named parameters to namespace.
- [`packages/infra/scripts/bootstrap.sh`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/infra/scripts/bootstrap.sh) — deploy and plan roles; the policy source of truth.
- [`packages/infra/lambda_staging.tf`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/infra/lambda_staging.tf) — `GRAPH_BASE_URL` and the hardcoded delta URL.
- [`packages/infra/custom_domain.tf`](https://github.com/jaybeeuu/petroglyph/blob/main/packages/infra/custom_domain.tf) — `api_custom_domain` already optional.
- [`.github/workflows/deploy.yml`](https://github.com/jaybeeuu/petroglyph/blob/main/.github/workflows/deploy.yml) — the pipeline to promote through QA.
- [`docs/ops.md`](../ops.md) — bootstrap guardrails, environment secrets, and manual secret steps.
- The parked real-AWS / live-Graph verification idea (an untracked backlog note at the time of writing): this direction absorbs only its deterministic half; the live-Graph tier stays opt-in and never gates.
