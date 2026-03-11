# Creating a New Package

Follow the `packages/core` pattern to add a new package to the workspace.

## Steps

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
       "build": "tsc --project tsconfig.build.json",
       "lint": "eslint src",
       "test": "vitest run",
       "typecheck": "tsc --project tsconfig.json --noEmit"
     },
     "engines": {
       "node": ">=24.0.0"
     }
   }
   ```

   **`packages/<name>/tsconfig.json`** — used by the `typecheck` script; covers all files in the package so configs and test helpers are also type-checked.

   ```json
   {
     "extends": "../../tsconfig.base.json",
     "exclude": ["dist"]
   }
   ```

   **`packages/<name>/tsconfig.build.json`** — used by the `build` script; restricts the compiler to `src/` and emits output to `dist/`.

   ```json
   {
     "extends": "./tsconfig.json",
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
