# Agent Instructions

## Working Documents

Checklists, scratch pads, and other operational notes that should **not** be committed belong in `.working-docs/`. That directory is gitignored.

Never put working documents in `docs/` or any other tracked directory.

## Validation

- **zod is the single validation library.** Validate ALL data arriving from external systems with
  zod where the shape could be incorrect — SQS messages, DynamoDB records, webhook payloads,
  OAuth responses. Do not add other shape-validation libraries; `@jaybeeuu/is` is being removed
  and must not be reintroduced.

## Generic type naming

- Name generic type parameters after their role/payload — `Envelope<Payload>`, `Queue<Message>` —
  never a bare `T`. A reader should know what the parameter is without reading the callsite.

## Pull Request Hygiene

Before asking the user to review or merge a PR, you **must** verify:

1. **Branch is up to date** — rebase onto `main` and force-push if behind.
2. **All CI checks pass** — use `gh run watch <run-id> --exit-status` to confirm build, lint, format, typecheck, and test jobs are green.
3. **Format is clean** — run `pnpm format` locally before committing to avoid format-check failures in CI.

Do not ask the user to merge until all three conditions are met.
