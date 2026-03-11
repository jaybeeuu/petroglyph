# @petroglyph/core

Shared-kernel package for the Petroglyph monorepo. Contains narrow, stable primitives that are
generic enough to belong to no single bounded context.

## Purpose and Boundary Rules

This package is the **shared kernel** — a deliberately small set of types and helpers used across
multiple bounded contexts. It must stay narrow and stable. Do not add service-owned contracts here
just to make imports convenient.

**Belongs here:**

- Branded ID types and their cast/guard helpers
- Generic `Result` type and combinators
- Validation error shapes and schema-version helpers

**Does NOT belong here:**

- Domain types or types owned by a specific bounded context (e.g. user/account, ingress, processing, API)
- API request/response shapes owned by a specific service
- Database models, ORM entities, or persistence schemas
- Business logic, workflows, or use-case implementations
- Ingress or processing pipeline contracts
- Note lifecycle event schemas — these are owned by the ingress bounded context and defined there
  (see [ADR 0013](../../docs/adrs/0013-note-event-contract-ownership.md) and issue #7)

## Exported Families

### `ids`

Branded string types to prevent accidental ID mix-ups at compile time. Each brand groups its
type, cast helper, and type guard together.

```ts
import { asNoteId, isNoteId, type NoteId } from "@petroglyph/core";

const id: NoteId = asNoteId("abc-123");
isNoteId("abc-123"); // true — runtime check is typeof === "string"
```

Available brands: `NoteId`, `VersionId`, `ProviderId`, `ProviderConnectionId`, `ApplicationUserId`.
Each has a corresponding `as*` cast helper and `is*` type guard.

### `result`

Discriminated-union `Result<Value, Reason>` for explicit error handling without exceptions.
`ok()` returns `Success<Value>` and `fail()` returns `Failure<Reason>`.

```ts
import { fail, isOk, ok, type Result } from "@petroglyph/core";

function divide(a: number, b: number): Result<number, string> {
  if (b === 0) return fail("division by zero");
  return ok(a / b);
}

const result = divide(10, 2);
if (isOk(result)) {
  console.log(result.value); // 5
}
```

### `validation`

Typed validation error shapes and schema-version compatibility.

```ts
import { type ValidationResult, isCompatibleSchemaVersion } from "@petroglyph/core";

const result: ValidationResult<string> = fail({
  errors: [{ path: "email", message: "invalid format" }],
});

isCompatibleSchemaVersion(2, 2); // true
isCompatibleSchemaVersion(1, 2); // false
```

## Development

```sh
pnpm --filter @petroglyph/core test       # run tests
pnpm --filter @petroglyph/core typecheck  # type-check
pnpm --filter @petroglyph/core lint       # lint
pnpm --filter @petroglyph/core build      # compile to dist/
```
