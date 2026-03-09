# 0006. Package Layout and CI Workflow

- **Status:** Accepted
- **Date:** 2026-03-09

## Context

The notes platform will live in its own repository. The implementation still needs a predictable package layout, a small initial package set, and CI workflows that can validate only the packages affected by a change. New deployable pieces will eventually be provisioned into AWS with Terraform.

## Decision Drivers

- clear ownership under a conventional top-level `packages/` directory
- minimal initial package complexity
- targeted validation rather than full-repo rebuilds on every change
- CI design that does not depend on a legacy host repository
- room to split packages later if needed

## Considered Options

### Option 1: Fit notes work into existing `packages/` layout only

Add notes code under `packages/` and follow the current layout strictly.

### Option 2: Create a dedicated repository with a small set of initial packages under `packages/`

Use `packages/` as the package root and design workspace and CI behavior around that layout from the start.

### Option 3: Build notes as one large package first

Keep all notes implementation in a single package until it becomes too large.

## Decision Outcome

Chosen option: **Create a dedicated repository with a small set of initial packages under `packages/`**.

This means:

- packages live under `packages/`
- the initial package count stays small (`core`, `api`, `ingest-onedrive`, `processor`, `cli`, `infra`)
- `pnpm-workspace.yaml` should include `packages/*`
- root scripts and CI filters should support targeted build, lint, type-check, and test workflows for changed packages
- the CI provider can be chosen independently; the required behavior is package-scoped validation rather than a specific vendor
- optimization should focus on changed-package execution before adding more platform complexity

## Consequences

### Positive

- package ownership is conventional and easy to discover
- workspace ownership becomes clearer
- selective CI remains possible with simple package path filters
- package boundaries can evolve without moving the whole codebase again later

### Negative

- CI still needs changed-package detection and dependency-aware validation logic
- initial package split still requires judgment to avoid over-fragmentation
- a dedicated repository gives up any shared automation that might have existed elsewhere and must define its own baseline scripts

## Validation

- workspace commands can target packages explicitly
- changes limited to one package can run targeted validation in CI
- notes packages build and type-check without forcing unrelated full-repo work on every PR

## Links

- [Target Service and Package Architecture](../target-service-and-package-architecture.md)
