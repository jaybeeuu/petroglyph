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

| Layer                   | Proves                                                   | Infrastructure                                      | Runs in `pnpm test` | Status                                         |
| ----------------------- | -------------------------------------------------------- | --------------------------------------------------- | ------------------- | ---------------------------------------------- |
| Component / integration | a package's behaviour against real services              | LocalStack (Docker)                                 | Yes                 | In place                                       |
| Service boundary        | a deployed handler wires its collaborators correctly     | LocalStack (Docker)                                 | Yes                 | Partial — handler tests exist with mocked deps |
| Contract                | producer and consumer agree on the payloads between them | None                                                | Yes                 | Planned                                        |
| Deployed smoke          | the deployed path works end to end                       | QA environment (Graph stubbed via `GRAPH_BASE_URL`) | No                  | Planned                                        |
| Live Microsoft Graph    | behaviour against the real Microsoft edge                | Real Graph (throwaway account)                      | No                  | Opt-in, never scheduled                        |

The deployed smoke is the release gate: the deploy pipeline promotes through QA (deploy QA → smoke → deploy production). The live-Graph tier is opt-in and never gates. See [technical-direction/verification-strategy.md](technical-direction/verification-strategy.md) for the decision and rationale.

[CONTRIBUTING.md](../CONTRIBUTING.md) holds the workspace commands and package script conventions.
