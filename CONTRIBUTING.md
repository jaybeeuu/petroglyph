# Contributing

This guide covers how to bootstrap the repository on a new machine, run packages locally, and align with the CI validation workflow.

## Prerequisites

| Tool    | Version | Install                                                                |
| ------- | ------- | ---------------------------------------------------------------------- |
| Node.js | 24.x    | [nvm](https://github.com/nvm-sh/nvm): `nvm install` or `nvm use`       |
| pnpm    | 10.x    | `npm install -g pnpm` or [official docs](https://pnpm.io/installation) |

The `.nvmrc` file pins Node.js 24.
Run `nvm use` from the repository root to switch to the correct version automatically.

## Bootstrap

```sh
# 1. Switch to the correct Node.js version
nvm use

# 2. Install all workspace dependencies
pnpm install

# 3. Copy the workspace environment variable template
cp .env.example .env
# Edit .env if needed. The defaults work for a mocked local session.
# Each package also provides its own .env.example for package-specific variables.
# Copy and edit the relevant package .env.example files for the packages you are running locally.
```

After bootstrap, verify the setup with:

```sh
pnpm typecheck   # type-check all packages
pnpm lint        # lint all packages
pnpm test        # run all package tests
pnpm build       # build all packages
```

All four commands should complete without errors on a clean checkout.

## Local Development

### Start a single package

```sh
pnpm --filter @petroglyph/<name> dev
```

Replace `<name>` with one of: `api`, `ingest-onedrive`, `processor`, `plugin`, `infra`, `core`.

### Start all packages together

```sh
pnpm dev
```

This runs the `dev` script across all packages in dependency order.

### Auth and environment

By default, `AUTH_MODE=mock` is set in `packages/api/.env.example`.
This removes the Microsoft Entra dependency from the development loop so no cloud credentials are needed for a local session.

See [docs/local-runtime-model.md](docs/local-runtime-model.md) for the full local process model and a description of what runs locally versus remotely.
See [docs/environment-variables.md](docs/environment-variables.md) for a complete environment variable reference.

## Workspace Scripts

Run from the repository root:

| Command             | Description                              |
| ------------------- | ---------------------------------------- |
| `pnpm build`        | Build all packages                       |
| `pnpm lint`         | Lint all packages                        |
| `pnpm typecheck`    | Type-check all packages                  |
| `pnpm test`         | Run all package tests                    |
| `pnpm dev`          | Start all packages in development mode   |
| `pnpm format`       | Format all files with Prettier           |
| `pnpm format:check` | Check formatting without writing changes |

Run a single package command:

```sh
pnpm --filter @petroglyph/<name> <script>
```

## Package Script Conventions

Each package should expose the following scripts where applicable:

| Script      | Description                                                                |
| ----------- | -------------------------------------------------------------------------- |
| `build`     | Compile TypeScript to `dist/` using `tsc`                                  |
| `lint`      | Run ESLint over `src/`                                                     |
| `typecheck` | Type-check without emitting output                                         |
| `test`      | Run unit and mocked integration tests with Vitest                          |
| `dev`       | Start the package in development mode using `tsx` for TypeScript execution |

See [docs/creating-a-package.md](docs/creating-a-package.md) for the canonical package scaffolding template.

## Testing

### Fast local checks (run these first)

```sh
pnpm typecheck   # TypeScript type-checking
pnpm lint        # ESLint
pnpm test        # Vitest unit and mocked integration tests
```

These checks run entirely locally with no network or cloud dependency.

### Mocked integration checks

Integration tests that use in-process stubs for AWS services (S3, SQS, DynamoDB) run as part of `pnpm test`.
No real AWS credentials or LocalStack are required.

### Optional local-against-remote checks

Tests or scripts that connect to real AWS, Entra, or OneDrive services are opt-in.
They are not part of `pnpm test` and must be run explicitly.
Set the appropriate variables in your `.env` and follow the package-level instructions in each package's `LOCAL.md` (when present).

## CI Alignment

CI runs the same commands as local validation. See [README.md](README.md#ci-checks) for the full CI job breakdown.

The key local commands that align with CI jobs:

1. `pnpm build`
2. `pnpm format:check`
3. `pnpm lint`
4. `pnpm typecheck`
5. `pnpm test`

If all five pass locally, they should pass in CI.

## Code Style

- TypeScript strict mode is on by default.
- ESLint flat config via `@jaybeeuu/eslint-config/base` covers all packages.
- Prettier handles formatting.
- Run `pnpm format` before committing to keep formatting consistent.
- See `eslint.config.js` and `.prettierrc.json` at the repository root for the current config.

## Adding a New Package

Follow the instructions in [docs/creating-a-package.md](docs/creating-a-package.md).

## Troubleshooting

| Symptom                              | Likely cause                           | Fix                                           |
| ------------------------------------ | -------------------------------------- | --------------------------------------------- |
| `pnpm: command not found`            | pnpm not installed                     | `npm install -g pnpm`                         |
| Wrong Node.js version                | nvm not active or `.nvmrc` not loaded  | `nvm use` from the repository root            |
| `Module not found` in tests          | Packages not built before tests        | `pnpm build` then re-run tests                |
| Tests fail with missing env variable | `.env` not present or variable not set | `cp .env.example .env` and fill in values     |
| Lint errors after adding a package   | Missing `eslint.config.js` extension   | Check `eslint.config.js` includes the package |
