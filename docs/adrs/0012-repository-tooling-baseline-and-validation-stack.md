# 0012. Repository Tooling Baseline and Validation Stack

- **Status:** Accepted
- **Date:** 2026-03-10

## Context

The repository is moving from architecture planning into package scaffolding and implementation.
Several cross-cutting tooling decisions need to be made before package work begins in earnest:

- test runner for unit and mocked integration tests
- linting and formatting approach
- baseline TypeScript build and type-check workflow
- local TypeScript execution approach for scripts, CLIs, and service entrypoints

These are repository-wide concerns rather than one bounded context's internal implementation detail.
Without an explicit decision, issue work will drift into inconsistent package-local choices and the developer experience will become harder to standardize.

## Decision Drivers

- low-complexity workspace baseline
- fast local feedback for package-local development
- strict TypeScript-first workflow
- compatibility with `pnpm` package filtering and GitHub Actions
- clear separation between unit or mocked integration tests and slower end-to-end verification
- no bundle-first requirement for every package by default
- room for package-specific exceptions later when justified by context

## Considered Options

### Option 1: Vitest + ESLint flat config + Prettier + `tsc`/`tsx` baseline

Use Vitest for unit and mocked integration tests, ESLint flat config based on `@jaybeeuu/eslint-config` for linting, Prettier for formatting, `tsc` for baseline build and type-checking, and `tsx` for local TypeScript execution.

### Option 2: Jest + ESLint + Prettier + `ts-jest` or transpile-heavy baseline

Use Jest as the main test runner, keep ESLint and Prettier, and rely on Jest-specific TypeScript integration for a large part of the execution path.

### Option 3: Biome + bundle-first toolchain + mixed test runners

Use Biome for linting and formatting, adopt a bundle-first build flow such as `tsup` or `esbuild` by default, and allow packages to pick their own testing tools.

## Decision Outcome

Chosen option: **Vitest + ESLint flat config + Prettier + `tsc`/`tsx` baseline**.

This means:

- Node.js 24 is the repository runtime baseline for local development and CI.
- `pnpm` remains the workspace package manager.
- TypeScript is strict and ESM-first by default.
- `tsc` is the default baseline for package build output and type-checking.
- `tsx` is the default tool for local execution of TypeScript entrypoints and scripts.
- ESLint flat config is the canonical linting framework.
- `@jaybeeuu/eslint-config` is the base lint configuration for the repository.
- The repository should extend that base configuration where needed for Vitest-specific globals and rules, because the current shared config is expected to reflect Jest more completely than Vitest.
- Prettier is the canonical formatting tool.
- Vitest is the default runner for unit tests and mocked integration tests.
- Manual end-to-end checks and local runnable slice verification remain outside the default fast test runner path and should be documented separately.
- Packages should expose a common baseline script shape where relevant: `lint`, `typecheck`, `test`, and `build`.
- A package may adopt additional tooling later only when its bounded context has a clear need that the baseline does not meet.

## Consequences

### Positive

- repository tooling remains conventional and easy to understand
- package-local development gets fast feedback loops
- TypeScript build and runtime behavior are easier to reason about than with a bundle-first default
- the repository can reuse an existing linting baseline rather than inventing one from scratch
- linting and formatting decisions are explicit and consistent across packages
- testing guidance can distinguish fast automated checks from slower local or operator verification
- CI can run predictable package-filtered `lint`, `typecheck`, and `test` commands

### Negative

- packages that later need bundling still have to add a bounded-context-specific tool on top of the baseline
- using ESLint and Prettier together has more moving parts than an all-in-one tool
- Vitest is a better fit for the chosen stack than Jest, but some developers may be more familiar with Jest defaults
- the shared ESLint base may need repository-local extension to support Vitest cleanly
- `tsc` as the default build path may be slower than highly optimized bundlers for some packages

## Validation

- root workspace config defines the `pnpm` workspace and shared TypeScript baseline
- root or shared config defines ESLint flat config based on `@jaybeeuu/eslint-config`, plus any needed Vitest-specific extension, and Prettier
- package-local scripts use the baseline command shape where relevant
- GitHub Actions can run package-filtered `lint`, `typecheck`, and `test` commands
- issue planning for developer setup and testing strategy references the same tooling decisions

## Links

- [ADR 0006](0006-package-layout-and-ci-workflow.md)
- [Target Service and Package Architecture](../target-service-and-package-architecture.md)
- [docs/readme.md](../readme.md)
