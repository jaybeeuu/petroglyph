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

## What runs where

| Test level                                     | Needs Docker    | Runs in `pnpm test` |
| ---------------------------------------------- | --------------- | ------------------- |
| Unit and mocked integration (in-process stubs) | No              | Yes                 |
| Container-backed integration (Testcontainers)  | Yes — mandatory | Yes                 |
| Real-cloud integration (AWS, Entra, OneDrive)  | No              | No — opt-in         |

[CONTRIBUTING.md](../CONTRIBUTING.md) holds the workspace commands and package script conventions.

## Writing tests

Read the `style-tests` skill before writing or reviewing any test. It defines assertion strategy,
mock discipline, test-data construction, and the ban on skipped tests that the rule above enforces.
