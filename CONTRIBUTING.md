# Contributing

This guide covers how to bootstrap the repository on a new machine, run packages locally, and align with the CI validation workflow.

## Prerequisites

| Tool    | Version | Install                                                                           |
| ------- | ------- | --------------------------------------------------------------------------------- |
| Node.js | 24.x    | [nvm](https://github.com/nvm-sh/nvm): `nvm install` or `nvm use`                  |
| pnpm    | 10.x    | `npm install -g pnpm` or [official docs](https://pnpm.io/installation)            |
| Docker  | Current | [Docker Engine](https://docs.docker.com/engine/install/); required by `pnpm test` |

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

Each package ships its own `.env.example`; copy the ones for the packages you run and edit them in place.

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

| Script      | Description                                                                    |
| ----------- | ------------------------------------------------------------------------------ |
| `build`     | Compile TypeScript to `dist/` using `tsc`                                      |
| `lint`      | Run ESLint over `src/`                                                         |
| `typecheck` | Type-check without emitting output                                             |
| `test`      | Run unit and mocked integration tests with Vitest                              |
| `dev`       | Start the package in development mode using `tsx` for TypeScript execution     |
| `package`   | Produce a Lambda deployment artifact (`lambda.zip`) via `pnpm build` + staging |

Mirror an existing package for scaffolding — `packages/staging-consumer` is the reference (`package.json`, `tsconfig.json`, `vitest.config.ts`, `eslint.config.js`).

### Generated code

`packages/contracts` owns the API surface. `src/operations/` declares one operation per served route, and `scripts/generate-openapi.ts` emits `openapi.yaml` at that package's root. The YAML is generated from the operation registry and committed, so a change to the API surface shows as a reviewable diff. Never hand-edit it: `prebuild`, `pretypecheck`, and `pretest` regenerate it, and the `build` job's drift check fails when the committed file differs from the registry. Change the operation registry, never the YAML.

`packages/api-client` generates its types into `src/generated/openapi-types.ts` from that spec, regenerating the spec first. The types are gitignored too.

`packages/api` generates nothing. `packages/contracts/test/parity.test.ts` holds the registry to the routes the `api` and `staging-delivery` apps register, so a route with no registry entry and a registry entry with no route both fail `pnpm test`.

To add or change a route, edit the operation module in `packages/contracts/src/operations/` — path, method, and any `params`/`query`/`body` zod schemas — then write the handler as `defineEndpoint(operation, handler)` beside its siblings in `packages/api/src/` and add it to `createHandlers()` in `packages/api/src/routes.ts`. That map is typed over every operation the app serves, so a missing entry fails typecheck (`TS2741`). Nothing else may call `app.<method>`: `registerRoutes()` owns registration. Keep `defineEndpoint` on the `@petroglyph/contracts/hono` subpath, so a consumer of the root entry point never pulls hono into its graph.

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

### Container-backed integration checks

Some integration tests exercise real services through Testcontainers — for example, the LocalStack
DynamoDB suite in `packages/events`. **Docker is a hard requirement** for these tests and the daemon
must be running and reachable. A missing or unreachable Docker fails the suite rather than skipping
it, so a red run means fixing the environment — start the daemon or provision it in CI — not
skipping the suite. A test that never runs proves nothing. See [docs/testing.md](docs/testing.md)
for how to detect Docker and what to do when it is absent.

### Optional local-against-remote checks

Tests or scripts that connect to real AWS, Entra, or OneDrive services are opt-in.
They are not part of `pnpm test` and must be run explicitly.
Set the appropriate variables in your `.env` and follow the package-level instructions in each package's `LOCAL.md` (when present).

### Recorded coverage gap: real-AWS presigned-URL signature enforcement

The LocalStack suites cannot exercise presigned-URL signature enforcement: LocalStack 3.8.1 accepts a
tampered signature even with `S3_SKIP_SIGNATURE_VALIDATION=0` (checksum / `UNSIGNED-PAYLOAD` quirks).
The decision (petroglyph-f2ei) is to keep that case in
`packages/staging-contracts/src/object-store.integration.test.ts` as a skipped canary that states its reason,
rather than weaken the `403` assertion. The assertion runs whenever the endpoint enforces
signatures, so pointing that test at a real bucket in an opt-in run is how the gap is closed.

## CD Secrets

The Deploy workflow (`.github/workflows/deploy.yml`) runs a deploy job per environment (`deploy-qa` and `deploy-production`). Each requires three GitHub Actions secrets on its own GitHub environment (`qa` and `production`). For full deployment and infrastructure setup instructions, see [docs/ops.md](docs/ops.md).

| Secret                   | Description                                                  |
| ------------------------ | ------------------------------------------------------------ |
| `AWS_ROLE_ARN`           | ARN of the IAM role assumed via OIDC for deployments         |
| `TF_STATE_BUCKET`        | S3 bucket name used to store Terraform remote state          |
| `LAMBDA_ARTIFACT_BUCKET` | S3 bucket name used to store Lambda deployment ZIP artifacts |

`TF_STATE_BUCKET` and `LAMBDA_ARTIFACT_BUCKET` may point to the same bucket or separate buckets depending on your infrastructure setup.

Each deploy job targets its own GitHub Actions environment. Configure `production` so only `main` can deploy, and add any required reviewers or other protection rules there; `qa` holds its own deploy role, so a job in that environment cannot deploy production.

## CD Artifact Versioning

Lambda deployment ZIPs are stored in `LAMBDA_ARTIFACT_BUCKET` using a **content-hash key**: `lambda-<sha256>.zip`, where `<sha256>` is the SHA-256 digest of the ZIP file produced by `pnpm --filter @petroglyph/api package`.

This means:

- **No-op deploys**: If a merge to `main` changes no application code (e.g., docs-only or infra-only change), the packaged ZIP is identical to the previous one. The CD workflow detects that the content-hash key already exists in S3 and skips the upload. Terraform sees the same `api_zip_s3_key` as the previous run and produces a no-op `apply` for the Lambda function.
- **Code changes**: When application code changes, the ZIP content differs, producing a new SHA-256 digest and a new S3 key. Terraform detects the key change and updates the Lambda function.

The content-hash key is computed and exposed as a step output (`steps.artifact-hash.outputs.hash`) in the `deploy` job before the upload and Terraform steps run.

## CI Alignment

Validation runs the same commands as local validation. The workflow is defined in [`.github/workflows/validate.yml`](.github/workflows/validate.yml) and triggers on every pull request regardless of base branch (so stacked `epic/*` and feature PRs are validated too), plus a `main`-only push so merged history runs once. Each check runs in a parallel job after a shared `install` job warms the pnpm store cache.

The key local commands that align with CI jobs:

1. `pnpm build`
2. `pnpm format:check`
3. `pnpm lint`
4. `pnpm typecheck`
5. `pnpm test`

If all five pass locally, they should pass in CI.

Branch protection on `main` requires all five checks to pass before a pull request can be merged.

## Code Style

- TypeScript strict mode is on by default.
- ESLint flat config via `@jaybeeuu/eslint-config/base` covers all packages.
- Prettier handles formatting.
- Run `pnpm format` before committing to keep formatting consistent.
- See `eslint.config.js` and `.prettierrc.json` at the repository root for the current config.

## Adding a New Package

Create the directory under `packages/` — the `packages/*` glob in `pnpm-workspace.yaml` picks it up — and mirror an existing package. `packages/staging-consumer` is the reference for `package.json`, `tsconfig.json`, `vitest.config.ts`, and `eslint.config.js`.

## Plugin Development

The `plugin` package depends on the Obsidian API, which is only available inside a running Obsidian instance.
Tests use a manual mock at `packages/plugin/src/__mocks__/obsidian.ts` that stubs the Obsidian classes and APIs needed by the plugin.
Vitest automatically picks up `__mocks__` directories adjacent to the source files, so no explicit `vi.mock` call is needed in test files.

When adding tests that touch new Obsidian APIs, extend the mock first.

### Build, install, reload

Obsidian loads a plugin from `<vault>/.obsidian/plugins/petroglyph/`. A plugin change needs three steps, in this order.

**1. Build the staged plugin folder.**

```sh
pnpm --filter @petroglyph/plugin package
```

This writes `packages/plugin/release/`, holding `main.js`, `manifest.json` and `styles.css`, with `obsidian` left external. The folder is gitignored. `packages/plugin/release/` is the staged folder, not `dist/`: `pnpm build` and `pnpm dev` write `dist/`, so a development build cannot be mistaken for a release.

The plugin version lives only in `packages/plugin/manifest.json`. The package copies that file verbatim into the staged folder, and `packages/plugin/package.json` has no `version` field, so the two cannot disagree. Bump `manifest.json` to release a new version.

**2. Copy the staged folder into a vault.**

```sh
pnpm --filter @petroglyph/plugin install:vault -- /path/to/vault
```

Pass the vault path as the only argument. The script refuses to run without one, refuses a directory with no `.obsidian/`, and refuses when nothing has been staged. It copies into `<vault>/.obsidian/plugins/petroglyph/`. No vault path is stored in the repository, and there is no default path.

**3. Reload Obsidian.**

Run **Reload app without saving** from the command palette, or restart Obsidian. Obsidian does not load the new build until it reloads.

## Troubleshooting

| Symptom                                             | Likely cause                                      | Fix                                                            |
| --------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------- |
| `pnpm: command not found`                           | pnpm not installed                                | `npm install -g pnpm`                                          |
| Wrong Node.js version                               | nvm not active or `.nvmrc` not loaded             | `nvm use` from the repository root                             |
| `Module not found` in tests                         | Packages not built before tests                   | `pnpm build` then re-run tests                                 |
| `Cannot find module './generated/openapi-types.js'` | Generated OpenAPI types absent from a fresh clone | Run `pnpm typecheck` (or any build, typecheck, or test script) |
| Tests fail with missing env variable                | `.env` not present or variable not set            | `cp .env.example .env` and fill in values                      |
| Lint errors after adding a package                  | Missing `eslint.config.js` extension              | Check `eslint.config.js` includes the package                  |
