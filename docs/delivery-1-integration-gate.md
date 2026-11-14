# Delivery 1 integration gate — evidence

**Gate bead:** `petroglyph-j1gn.52` · **Assembled:** 2026-11-13 · **`main` at assembly:** `5738890`

This is a point-in-time record. A link that still resolves proves the state on the assembly date,
not the state now — re-run the checks before treating this as current proof.

This record covers the machine-checkable half of the Delivery 1 gate: green CI on `main` for every
delivered chunk, the four per-package LocalStack suites, the chunk-9 deploy run, and the boundary
tests. The production run-through lives in `petroglyph-twiy`; the vault proof lives in
`petroglyph-a75t`.

Workflow names: "Validate" is `.github/workflows/validate.yml`; "Deploy" is
`.github/workflows/deploy.yml`. Every run below is a `push` event on `main`, matched by the merge
commit SHA.

## Green CI on `main`, per delivered chunk

| Chunk                                | Bead                 | PR                                                      | Merge commit | Validate on `main`                                                                         | Deploy on `main`                                                                           |
| ------------------------------------ | -------------------- | ------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Chunk 0 — validation + CI hygiene    | `petroglyph-j1gn.42` | [#121](https://github.com/jaybeeuu/petroglyph/pull/121) | `b17469a`    | [36060866451](https://github.com/jaybeeuu/petroglyph/actions/runs/36060866451) success     | [36060866592](https://github.com/jaybeeuu/petroglyph/actions/runs/36060866592) success     |
| Chunk 1 — events                     | `petroglyph-j1gn.43` | [#130](https://github.com/jaybeeuu/petroglyph/pull/130) | `fa5201c`    | [36188315639](https://github.com/jaybeeuu/petroglyph/actions/runs/36188315639) success     | [36188315595](https://github.com/jaybeeuu/petroglyph/actions/runs/36188315595) success     |
| Chunk 2 — core token primitives      | `petroglyph-j1gn.44` | [#126](https://github.com/jaybeeuu/petroglyph/pull/126) | `e8551e9`    | [36059624982](https://github.com/jaybeeuu/petroglyph/actions/runs/36059624982) success     | [36059624988](https://github.com/jaybeeuu/petroglyph/actions/runs/36059624988) success     |
| Chunk 3 — staging-contracts          | `petroglyph-j1gn.45` | [#145](https://github.com/jaybeeuu/petroglyph/pull/145) | `96a23f7`    | [36347950770](https://github.com/jaybeeuu/petroglyph/actions/runs/36347950770) success     | [36347950769](https://github.com/jaybeeuu/petroglyph/actions/runs/36347950769) success     |
| Chunk 4 — ingest-onedrive tokens     | `petroglyph-j1gn.46` | [#127](https://github.com/jaybeeuu/petroglyph/pull/127) | `d7c64ad`    | [36063934759](https://github.com/jaybeeuu/petroglyph/actions/runs/36063934759) success     | [36063934834](https://github.com/jaybeeuu/petroglyph/actions/runs/36063934834) success     |
| Chunk 5 — ingest-onedrive delta      | `petroglyph-j1gn.47` | [#135](https://github.com/jaybeeuu/petroglyph/pull/135) | `8cd03b8`    | [36223377926](https://github.com/jaybeeuu/petroglyph/actions/runs/36223377926) success     | [36223377933](https://github.com/jaybeeuu/petroglyph/actions/runs/36223377933) success     |
| Chunk 6 — ingest-onedrive land       | `petroglyph-j1gn.48` | [#159](https://github.com/jaybeeuu/petroglyph/pull/159) | `2c232e1`    | [36636679889](https://github.com/jaybeeuu/petroglyph/actions/runs/36636679889) success     | [36636679948](https://github.com/jaybeeuu/petroglyph/actions/runs/36636679948) success     |
| Chunk 7 — staging-consumer           | `petroglyph-j1gn.49` | [#156](https://github.com/jaybeeuu/petroglyph/pull/156) | `e7d9c3f`    | [36633628937](https://github.com/jaybeeuu/petroglyph/actions/runs/36633628937) success     | [36633628901](https://github.com/jaybeeuu/petroglyph/actions/runs/36633628901) success     |
| Chunk 8 — staging-delivery           | `petroglyph-j1gn.50` | [#162](https://github.com/jaybeeuu/petroglyph/pull/162) | `b21f638`    | [36781233072](https://github.com/jaybeeuu/petroglyph/actions/runs/36781233072) success     | [36781233008](https://github.com/jaybeeuu/petroglyph/actions/runs/36781233008) success     |
| Chunk 9 — infra + deploy wiring      | `petroglyph-j1gn.51` | [#166](https://github.com/jaybeeuu/petroglyph/pull/166) | `8a14814`    | [37424456374](https://github.com/jaybeeuu/petroglyph/actions/runs/37424456374) success     | [37424456335](https://github.com/jaybeeuu/petroglyph/actions/runs/37424456335) success     |
| Chunk 10 — staging dispatch consumer | `petroglyph-j1gn.55` | [#177](https://github.com/jaybeeuu/petroglyph/pull/177) | `099f1ea`    | [38308380337](https://github.com/jaybeeuu/petroglyph/actions/runs/38308380337) **failure** | [38308380291](https://github.com/jaybeeuu/petroglyph/actions/runs/38308380291) **failure** |
| Chunk 10 repair                      | —                    | [#180](https://github.com/jaybeeuu/petroglyph/pull/180) | `c31bb03`    | [38311285112](https://github.com/jaybeeuu/petroglyph/actions/runs/38311285112) success     | [38311285124](https://github.com/jaybeeuu/petroglyph/actions/runs/38311285124) success     |

Chunk 10's merge commit was red on `main`. The Validate build failed with
`src/dispatch-lambda.ts(4,10): error TS2305: Module '"@petroglyph/staging-contracts"' has no
exported member 'createStagedIndexStoreDdb'`; install and format-check passed, typecheck, lint and
test were skipped. Coalesced `#176`/`#177` class changes left `main` unbuildable for 27 minutes.
[PR #180](https://github.com/jaybeeuu/petroglyph/pull/180) repaired it; both workflows passed at
`c31bb03`, and both are green on the current `main`.

Current `main` `5738890`: Validate
[43176042785](https://github.com/jaybeeuu/petroglyph/actions/runs/43176042785) success, Deploy
[43176042805](https://github.com/jaybeeuu/petroglyph/actions/runs/43176042805) success.

## Per-package LocalStack suites

Run on 2026-11-13 in a clean worktree at `5738890`, with Docker up. Setup was
`pnpm install --frozen-lockfile` and `pnpm build` at default workspace concurrency; build exited 0.

| Boundary  | Package                        | Command                                           | Result                            |
| --------- | ------------------------------ | ------------------------------------------------- | --------------------------------- |
| Adapter   | `@petroglyph/ingest-onedrive`  | `pnpm --filter @petroglyph/ingest-onedrive test`  | 18 files, 148 tests passed        |
| Forwarder | `@petroglyph/staging-consumer` | `pnpm --filter @petroglyph/staging-consumer test` | 8 files, 36 tests passed          |
| Dispatch  | `@petroglyph/staging-consumer` | same run as forwarder                             | included in the 8 files, 36 tests |
| Delivery  | `@petroglyph/staging-delivery` | `pnpm --filter @petroglyph/staging-delivery test` | 8 files, 38 tests passed          |

Boundary test files in those runs:

| Boundary                                                                                                 | Test file                                                                                                                     | Test result             |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Adapter — `createAdapterHandler` with an `SQSEvent` against LocalStack S3 + event log                    | [`packages/ingest-onedrive/src/lambda.integration.test.ts`](../packages/ingest-onedrive/src/lambda.integration.test.ts)       | 1 test passed (11.7 s)  |
| Forwarder — `createForwarderHandler` with a real `DynamoDBStreamEvent` against LocalStack DDB + FIFO SQS | [`packages/staging-consumer/src/lambda.integration.test.ts`](../packages/staging-consumer/src/lambda.integration.test.ts)     | 1 test passed (19.9 s)  |
| Delivery — app handler with an API Gateway v2 event against LocalStack S3 + staged records               | [`packages/staging-delivery/src/index.integration.test.ts`](../packages/staging-delivery/src/index.integration.test.ts)       | 2 tests passed (20.4 s) |
| Dispatch — `createDispatchHandler` with an `SQSEvent` of CloudEvents against LocalStack DDB + S3         | [`packages/staging-consumer/src/dispatch.integration.test.ts`](../packages/staging-consumer/src/dispatch.integration.test.ts) | 3 tests passed (15.1 s) |

No suite skipped. The suites fail when Docker is absent, per [testing.md](testing.md).

## Chunk 9 deploy run

`petroglyph-j1gn.51` landed as [PR #166](https://github.com/jaybeeuu/petroglyph/pull/166), merge
commit `8a14814`. The Deploy run
[37424456335](https://github.com/jaybeeuu/petroglyph/actions/runs/37424456335) recorded `success`;
its jobs `build`, `package` and `deploy` all succeeded. This is the same run the bead records.

## Boundary tests — `petroglyph-up9y.2`

| PR                                                      | Content                                       | Landed on                                                                                       |
| ------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [#173](https://github.com/jaybeeuu/petroglyph/pull/173) | Adapter, forwarder and delivery boundary rows | `epic/petroglyph-up9y`                                                                          |
| [#181](https://github.com/jaybeeuu/petroglyph/pull/181) | Dispatch boundary row                         | `epic/petroglyph-up9y`                                                                          |
| [#183](https://github.com/jaybeeuu/petroglyph/pull/183) | Epic into `main`, merge commit `8cd6a74`      | Validate [39014088009](https://github.com/jaybeeuu/petroglyph/actions/runs/39014088009) success |

`#183` added `ingest-onedrive/src/lambda.integration.test.ts` (255 lines),
`staging-consumer/src/lambda.integration.test.ts` (229 lines),
`staging-consumer/src/dispatch.integration.test.ts` (217 lines) and
`staging-delivery/src/index.integration.test.ts` (219 lines). All four files pass when driven
locally against LocalStack (section above).

The Deploy run at the same commit,
[39014088033](https://github.com/jaybeeuu/petroglyph/actions/runs/39014088033), failed in the
`deploy-qa` / "Terraform workspace" step. That is the QA environment from `petroglyph-up9y.3`, not
the staging path. `main`'s Deploy recovered at `facba4a`
([40387415410](https://github.com/jaybeeuu/petroglyph/actions/runs/40387415410)) and is green at
`5738890`.
