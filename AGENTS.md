# AGENTS

## 1. Purpose

- This file gives coding agents the repository-wide rules for working safely in this codebase.
- This root `AGENTS.md` applies across the repository unless a more local `AGENTS.md` exists in a subdirectory and overrides it for that subtree.
- Agents should follow the most local applicable `AGENTS.md` for the files they are editing.
- Check the local package or project README and config files before changing behavior in that area.

## 2. Repository Overview

- This repository is a monorepo or a multi-package project with shared libraries, application code, tooling, and tests.
- The repository should follow a domain-driven design approach with explicit bounded contexts such as ingress, processing, API, CLI sync, identity/account, and infrastructure.
- Prefer understanding the package or project boundaries before making changes.
- Most source changes should happen in source directories, configuration, tests, and docs rather than generated output.
- The package manager used in this repository is `pnpm`.
- The primary language is `TypeScript`.
- CI/CD is achieved by using github actions.
- The IAC tool used is terraform.

## 3. Task Tracking

- Use GitHub Issues as the primary tracker for cloud-agent work.
- Use `bd` and the `beads-mcp` optionally for local planning, ready-work discovery, and dependency tracking.
- When both are used, keep GitHub as canonical and avoid duplicate unmanaged task lists in markdown or ad hoc notes.
- Track work before changing code and keep the relevant GitHub issue updated while implementing.
- If you use `bd`, prefer it as a working layer on top of GitHub-backed tasks:
  - use GitHub Issues for the authoritative task record, acceptance details, and status
  - use `bd ready --json` to find unblocked local work when helpful
  - create or update linked follow-up work when you discover dependencies or additional tasks
  - reconcile any important status changes back to GitHub before finishing

## 4. Git and PR Workflow

- Treat the default branch as protected unless told otherwise.
- Make changes on a branch and expect the normal path to be a pull request.
- Keep commits focused and easy to review.
- Avoid mixing unrelated project or package changes unless the task requires a cross-cutting change.
- If a task changes behavior across packages or projects, describe the cross-project impact clearly in the PR or task update.
- Prefer rebasing over merging when integrating upstream changes into a branch. Use `git rebase` rather than `git merge` to keep history linear and easy to follow. Only rebase branches that have not been shared with others; never rebase a branch once someone else has pulled or based work on it.

## 5. Working Rules

- Make minimal, focused changes that match the requested scope.
- Follow the naming, file layout, test style, and config patterns already used in the area you are editing.
- Preserve bounded-context boundaries. In particular, keep ingress and processing as separate domains connected through explicit event contracts.
- Keep types and contract definitions as close as possible to the package that owns the behavior or data they describe.
- When a package exposes a public contract, publish it from that owning package and have consumers import it from there rather than introducing or expanding a separate catch-all contract package.
- Avoid broad refactors unless they are required to complete the task.
- Keep docs, tests, and type definitions in sync with behavior changes.
- Prefer editing source, config, tests, and docs; only touch built output when the task explicitly requires it.

## 6. Typing

- Keep TypeScript or other static typing strict, self-documenting, and as complete as is feasible for the project you are changing.
- Prefer explicit types at module boundaries and public APIs: exported functions, component props, return values, config objects, parsed content, and shared interfaces should be clearly typed.
- Model domain concepts with named types when that improves clarity. Prefer readable type aliases, interfaces, discriminated unions, and typed result shapes over loose object literals.
- Avoid `any`, broad casts, and non-null assertions unless there is no practical alternative. If you must use one, keep it narrow and local.
- Prefer types that describe the real runtime contract.
- Use Zod to define types for all data that crosses context boundaries or passes between packages. Derive TypeScript types from Zod schemas with `z.infer` so the schema is the single source of truth for both runtime validation and static types.
- Validate inputs and outputs at the edges of the system. Do not assume user input, front matter, environment variables, file contents, network responses, third-party API payloads, or other external data already match your static types.
- Parse, validate, and narrow unknown data before it reaches core logic. Use `safeParse` to validate and narrow; do not cast or assume shape without validation at boundaries.
- Reuse existing repository patterns for validation and typing rather than inventing parallel approaches.
- Let inference work for local implementation details when it stays obvious, but do not rely on inference where it hides intent or weakens public API clarity.
- Keep type definitions updated with behavior changes so type-checking remains meaningful across package boundaries.

## 7. Commands

- Learn the repository's baseline runtime and package manager requirements before changing build or workflow behavior.
- Prefer targeted package or project commands first.
- Use full-repository validation only when touching shared code, workspace config, or behavior that crosses package boundaries.
- Check local `package.json`, build config, and README files before introducing or changing commands.

## 8. Version Management

- Follow the repository's existing release and versioning workflow rather than introducing a new one.
- If the repository uses automated versioning or changelog tooling, keep release-intent files and changelog inputs aligned with code changes.
- If you change a published package or public API, add the expected release metadata unless the task explicitly says not to.
- Do not manually edit generated version or changelog output when the repository's tooling is responsible for it.

## 9. Testing Expectations

- Run the narrowest relevant validation first.
- Prefer tests with a strong value-to-weight ratio: choose tests that give clear confidence for the maintenance cost, setup complexity, and runtime they add.
- Test behavior and public APIs rather than implementation details.
- For package-local changes, start with that package's lint, test, and type-check scripts.
- Use broader validation only when the change affects shared code, repository config, or behavior that crosses package boundaries.
- Keep tests independent, deterministic, and passing. Fix flakes instead of normalizing intermittent failures.
- Keep setup minimal and local to the test. Prefer obvious inline data and small helpers over hidden state, broad hooks, or over-abstracted fixtures.
- Treat test code like production code: keep it readable, maintainable, and aligned with the project's linting and typing standards.
- Prefer unit and integration tests for fast feedback, and use end-to-end coverage for the smaller set of critical user journeys where browser-level confidence is worth the extra weight.

## 10. Package Or Project Guidance

- Preserve established content models, manifest shapes, file naming conventions, selectors, and public API contracts unless the task requires a deliberate change.
- Be careful with cross-package dependencies and consumer-facing behavior.
- Shared libraries or shared-kernel packages should stay narrow and stable. They should only house generic concerns which don't belong to any particular bounded context. Do not move service-owned contracts into them just to make imports look convenient.
- Service packages should own and publish their own public contracts, including event shapes and client-facing resource models where applicable.
- Tooling and config changes can affect the whole repository; validate likely consumers after modifying them.

## 11. Change Safety

- Do not hand-edit generated or build output. This usually includes compiled directories, coverage artifacts, test reports, generated manifests, generated content, and generated certificates.
- Be careful with cross-package API changes; check dependents before finalizing them.
- Preserve backwards compatibility unless the task explicitly requires a breaking change.
- When in doubt, check the local README, package manifest, test config, type config, lint config, build config, and framework-specific config files before changing behavior.

## 12. Documentation

- Update READMEs, changelogs, and related docs when behavior, public APIs, or developer workflow changes materially.
- Keep documentation concise, practical, and aligned with the commands and workflows that already exist in the repository.
- If a change only affects internal implementation, avoid unnecessary doc churn in user-facing docs.
