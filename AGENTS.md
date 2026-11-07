# Agent Instructions

## Working Documents

Checklists, scratch pads, and other operational notes that should **not** be committed belong in `.working-docs/`. That directory is gitignored.

Never put working documents in `docs/` or any other tracked directory.

## Validation

- **zod is the single validation library.** Validate ALL data arriving from external systems with
  zod where the shape could be incorrect — SQS messages, DynamoDB records, webhook payloads,
  OAuth responses. Do not add other shape-validation libraries; `@jaybeeuu/is` has been removed
  from every package and must not be reintroduced.

## Testing

Docker is a mandatory development dependency — container-backed integration tests run real services
through Testcontainers and LocalStack, so `pnpm test` needs a running, reachable Docker daemon.

**Integration tests MUST fail, never skip, when Docker is unavailable.** Do not add a
`dockerAvailable()` guard or `describe.skipIf(!canRun)`: a skipped suite reports green while
proving nothing. Detect Docker with `docker info`; when it fails, start the daemon (or provision it
in CI) instead of skipping.

Read the `style-tests` skill before writing or reviewing any test. See [docs/testing.md](docs/testing.md)
for test levels, detection, and recovery.

## Module scope

**Importing a module must not construct an SDK client or an application, and must not do I/O.**
Pure module-scope work is fine — constants, regexes, a factory that returns a closure.

Build lazily instead. A client gets a `??=` accessor and a route table gets a `createApp()` factory.
When the first invocation must load configuration, cache an `init()` promise and clear it in the
rejection handler, so a failed attempt retries on the next invocation. A module-scope construction
couples every importer to the dependency graph and makes load order matter. Lint fails on
`new <Sdk>Client()` and `new Hono()` at module scope; see [eslint.config.js](eslint.config.js).

## Generic type naming

- Name generic type parameters after their role/payload — `Envelope<Payload>`, `Queue<Message>` —
  never a bare `T`. A reader should know what the parameter is without reading the callsite.

## Vocabulary

Domain vocabulary — user, provider, connection, profile; identity vs delegation — is canonical in
[docs/glossary.md](docs/glossary.md). Use those terms in plans, docs, code, and commit messages.

## Pull Request Hygiene

Before asking the user to review or merge a PR, you **must** verify:

1. **Branch is up to date** — rebase onto `main` and force-push if behind.
2. **All CI checks pass** — use `gh run watch <run-id> --exit-status` to confirm build, lint, format, typecheck, and test jobs are green.
3. **Format is clean** — run `pnpm format` locally before committing to avoid format-check failures in CI.

Do not ask the user to merge until all three conditions are met.
