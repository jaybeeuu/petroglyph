# Testing

Docker is a mandated development dependency. Integration tests exercise real services through
Testcontainers and LocalStack, so `pnpm test` requires a running, reachable Docker daemon.

**When Docker is unavailable, integration tests MUST fail — never skip.** A skipped suite reports
green while proving nothing, hiding a broken environment behind a passing build.

---

## Detecting Docker

The daemon is reachable when this exits `0`:

```sh
docker info
```

A non-zero exit — `Cannot connect to the Docker daemon` — means Docker is unavailable: the daemon
is not running, or the shell cannot reach its socket.

## When Docker is unavailable

Fix the environment; do not weaken the test.

- **Local:** start Docker Engine or Docker Desktop, wait for `docker info` to succeed, then re-run.
- **CI:** the workflow provides a Docker-capable runner. A missing daemon is an infrastructure
  failure to fix, not a suite to skip.
- **Never** silence the failure with a `dockerAvailable()` guard or `describe.skipIf(!canRun)`.
  Those convert a missing dependency into a green run.

The only permitted skip is the recorded LocalStack signature-gap canary, documented in
[CONTRIBUTING.md](../CONTRIBUTING.md); it skips because LocalStack cannot enforce presigned-URL
signatures, not because an environment is missing.

## Test layers

Each layer proves what the one below it cannot.

| Layer                   | Proves                                               | Infrastructure                                      | Runs in `pnpm test` | Status                                                             |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| Component / integration | a package's behaviour against real services          | LocalStack (Docker)                                 | Yes                 | In place                                                           |
| Service boundary        | a deployed handler wires its collaborators correctly | LocalStack (Docker)                                 | Yes                 | Adapter, forwarder, delivery, dispatch, connect, catch-up in place |
| Deployed smoke          | the deployed path works end to end                   | QA environment (Graph stubbed via `GRAPH_BASE_URL`) | No                  | In place                                                           |
| Live Microsoft Graph    | behaviour against the real Microsoft edge            | Real Graph (throwaway account)                      | No                  | Opt-in, never scheduled                                            |

Boundary suites drive the real handler with a realistic trigger: adapter (`SQSEvent` -> Graph delta -> S3 + event log), forwarder (`DynamoDBStreamEvent` -> FIFO message), delivery (API Gateway v2 request -> feed + presigned GET), dispatch (`SQSEvent` of staged CloudEvents -> `staged_records` rows + S3 object removal), connect (`POST /onedrive/connect` -> Microsoft token exchange -> `token_vaults` row + legacy `refresh_tokens` row), and the scheduled catch-up sweep (schedule tick -> token-vault scan -> FIFO bell).

The connect suite (`packages/api/src/onedrive-connect.integration.test.ts`) runs the real handler against LocalStack DynamoDB with a local HTTP server standing in for the Microsoft token endpoint, so no request leaves the machine. It asserts the `(userId, provider=onedrive)` row parses under `tokenRecordSchema` with `reconnectRequired: false`, and that the legacy `refresh_tokens` dual-write still fires.

The catch-up suite calls the deployed composition rather than the bare handler: `packages/ingest-onedrive/src/catch-up.integration.test.ts` invokes `createScheduledSweep`, so the vault scan and the FIFO send both run for real. It stubs `AWS_ENDPOINT_URL_DYNAMODB` and `AWS_ENDPOINT_URL_SQS` instead of passing endpoints to the clients, and gives each test a private table and queue. The clock is the only injected dependency: stepping `now` past the five-minute dedupe window re-bells without a real wait.

Cross-service payload drift is pinned by the shared `@petroglyph/staging-contracts` zod schema and `pnpm -r typecheck`, which fail in the same commit as the change; there is no separate contract layer ([technical-direction/pact-contract-tests.md](technical-direction/pact-contract-tests.md)).

The deployed smoke is the release gate: the deploy pipeline promotes through QA (deploy QA → smoke → deploy production). The live-Graph tier is opt-in and never gates. See [technical-direction/verification-strategy.md](technical-direction/verification-strategy.md) for the decision and rationale.

## Test timeouts

Vitest gives every test 5000 ms unless it is handed a budget of its own. A test that does real I/O — an S3 put, a DynamoDB upsert, an HTTP fetch of a presigned URL — can exceed that once the full suite runs in parallel on a loaded runner, so such tests pass an explicit timeout sized to the work they do: `packages/staging-delivery/src/delivery.integration.test.ts` runs its presigned download under 30 s and its `beforeAll` under 180 s. The budget stays per test rather than a package-wide `testTimeout`, so the headroom goes only to the tests that need it and unit tests keep failing fast.

## Suite parallelism

`packages/ingest-onedrive` runs its test files one at a time (`fileParallelism: false` in its `vitest.config.ts`) because four of its suites each start their own LocalStack container. Run together on a loaded machine, four LocalStack JVMs exhaust the RAM and the `beforeAll` budget expires; the failure looks like a code defect but is memory pressure. Keep the package serial unless the container count falls, and expect its suite to take longer than a parallel one.

[CONTRIBUTING.md](../CONTRIBUTING.md) holds the workspace commands and package script conventions.
