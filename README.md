# Petroglyph

Petroglyph is a notes-processing system for turning handwritten PDFs from an e-ink note device into structured, syncable notes.

The initial use case is an Onyx Boox Note Air workflow:

1. handwritten notes are created on the device
2. PDFs are synced to a cloud provider such as OneDrive
3. Petroglyph detects updates and processes those PDFs
4. processed outputs are made available through an authenticated API
5. a cross-platform CLI syncs the resulting notes into a local Obsidian vault

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 24 or later (use [nvm](https://github.com/nvm-sh/nvm): `nvm use`)
- [pnpm](https://pnpm.io/) 10 or later

### Bootstrap

```sh
nvm use          # switch to Node.js 24 as declared in .nvmrc
pnpm install     # install all workspace dependencies
```

### Workspace Commands

These commands run across all packages in the workspace:

| Command             | Description                              |
| ------------------- | ---------------------------------------- |
| `pnpm build`        | Build all packages                       |
| `pnpm lint`         | Lint all packages                        |
| `pnpm typecheck`    | Type-check all packages                  |
| `pnpm format`       | Format all files with Prettier           |
| `pnpm format:check` | Check formatting without writing changes |

### Shared Configuration

| File                  | Purpose                                            |
| --------------------- | -------------------------------------------------- |
| `tsconfig.base.json`  | Shared TypeScript config for ESM packages          |
| `eslint.config.js`    | Root ESLint config using `@jaybeeuu/eslint-config` |
| `.prettierrc.json`    | Shared Prettier formatting rules                   |
| `pnpm-workspace.yaml` | Declares `packages/*` as workspace members         |

### Creating a New Package

Follow the `packages/core` pattern:

1. Create `packages/<name>/` with the following files:

   **`packages/<name>/package.json`**

   ```json
   {
     "name": "@petroglyph/<name>",
     "version": "0.0.0",
     "private": true,
     "type": "module",
     "exports": {
       ".": {
         "import": "./dist/index.js",
         "types": "./dist/index.d.ts"
       }
     },
     "scripts": {
       "build": "tsc --project tsconfig.json",
       "lint": "eslint src",
       "typecheck": "tsc --project tsconfig.json --noEmit"
     },
     "engines": {
       "node": ">=24.0.0"
     }
   }
   ```

   **`packages/<name>/tsconfig.json`**

   ```json
   {
     "extends": "../../tsconfig.base.json",
     "compilerOptions": {
       "outDir": "dist",
       "rootDir": "src",
       "tsBuildInfoFile": "dist/.tsbuildinfo"
     },
     "include": ["src"]
   }
   ```

   **`packages/<name>/src/index.ts`** — add your entry-point exports here.

2. Run `pnpm install` from the repo root to register the new workspace package.

3. Run `pnpm build` to verify the new package compiles cleanly.

## Why This Exists

The current handwritten-note workflow is useful but fragmented.

- handwritten PDFs are easy to capture on the device
- syncing the raw files to cloud storage is straightforward
- turning those notes into searchable, structured material for Obsidian is still too manual
- local synchronization, retries, and change tracking need a deterministic system rather than ad hoc scripts

Petroglyph exists to provide that system.

## What The System Does

At a high level, the platform is intended to:

- detect note changes from cloud storage providers
- process handwritten-note PDFs into markdown plus extracted artifacts
- store originals and derived outputs in cloud storage
- expose note state and note changes through an authenticated API
- synchronize notes into one or more local Obsidian-compatible directories through a CLI
- leave room for future authenticated site-based note exploration

The first provider is OneDrive, but the architecture is being designed so additional providers can be added later.

## Current Scope

The current repository state is documentation-first. The architecture baseline, ADRs, and implementation planning are being established before package-level implementation begins.

Current assumptions include:

- OneDrive first for provider integration
- AWS for processing, storage, and API hosting
- a cross-platform CLI as the first consumer
- a single-user operational model in V1, with clean boundaries for future multi-user expansion
- an application-owned user/account model rather than treating external identity claims as the entire user model

## Development Approach

The intended development model is hybrid:

- application code should be runnable locally during development
- early phases may still depend on remote services such as AWS, Microsoft Entra, and OneDrive
- local testability and local developer setup are explicit implementation goals, not afterthoughts

## Repository Guide

This repository uses layered documentation.

- `README.md`
  - top-level purpose, scope, and orientation
- `docs/rfcs/`
  - high-level requirements and solution shape
- `docs/adrs/`
  - concrete architectural decisions
- GitHub issues
  - implementation planning, sequencing, and dependency tracking
- future task specs
  - developer-facing breakdown of implementation work inside the repository

Start with these documents:

- [docs/readme.md](docs/readme.md)
- [docs/rfcs/0001-notes-platform-architecture.md](docs/rfcs/0001-notes-platform-architecture.md)
- [docs/target-service-and-package-architecture.md](docs/target-service-and-package-architecture.md)
- [docs/adrs/readme.md](docs/adrs/readme.md)

## Top-Level Requirements

The top-level requirements for the system are:

- ingest note PDFs from a cloud provider after device sync
- detect changes reliably and replay safely
- transform PDFs into useful markdown and related artifacts
- preserve original PDFs alongside derived outputs
- expose synchronized note state through an authenticated API
- support local sync into Obsidian through a CLI
- keep the design extensible for additional providers and future authenticated site access

## What Is Not Here Yet

This repository does not yet contain the full package implementation described in the architecture docs.

The next implementation phase will focus on:

- local runtime orchestration
- mocked auth flows and Entra integration
- ingestion, processing, API, and CLI runtime behavior

## License

See [LICENSE](LICENSE).
