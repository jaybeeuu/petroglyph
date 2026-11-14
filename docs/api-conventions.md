# API conventions

The response envelope, decided 2026-11-05 (`petroglyph-m0jc.1`). Applies to every
route on the Petroglyph API, including the staging `/files` surface.

## Payloads are flat

A successful response body **is** the resource, with no `data` wrapper. No
standard exists for success envelopes, so the shape that needs the least
translation wins: the contracts package gives each operation an exact response
schema, so nesting would relocate the same information.

```json
GET  /profiles            [ { "profileId": "default", "active": true } ]
GET  /profiles/default     { "profileId": "default", "active": true }
GET  /files                { "files": [ … ], "nextToken": "eyJwcm9maWxl…" }
```

## Collections carry an opaque continuation token

`{ <resources>: [ … ], nextToken: string | null }`. Resume by sending the token
back verbatim as `?nextToken=`; never parse it, never derive it. `nextToken` keeps
its name — it is already implemented, the token is opaque, and renaming it to
`next_page_token` would be a client change for no gain.

## `meta` is reserved

`meta` is for cross-cutting data only — request correlation, deprecation notices.
It is never used to carry payload, and a payload key may not be named `meta`.

```json
{ "files": [ … ], "nextToken": null, "meta": { "requestId": "01J…" } }
```

## Requests are validated from the contract

Each operation declares its own `params`, `query` and `body` zod schemas in
`packages/contracts/src/operations/`. `defineEndpoint`
(`@petroglyph/contracts/hono`) runs them before the handler and passes the
parsed `{ params, query, body }`; no handler parses `c.req` to validate. A
rejected request answers `400` with the operation's own body — the flat
`{ "error": "…", "details": [ … ] }` the hand-written routes already used, not
the nested `invalid_request` envelope below.

Two consequences are worth knowing:

- Validation runs before the handler, so a malformed request against a resource
  that does not exist answers `400`, not `404`. A `400` is not proof the
  resource exists.
- A body is parsed whatever the `Content-Type` header says. Hono's `"json"`
  target validates `{}` when the header is absent, which drops a body the caller
  did send, and it lets malformed JSON escape as plain text instead of a JSON
  rejection. Reading the body directly keeps the answer the route gave before it
  had a schema.

Coverage is partial. Six operations declare request schemas. The path parameters
of `getProfile`, `deleteProfile`, `getFile` and `getSyncJob` are still
unvalidated, and `/auth/url` and `/onedrive/auth-url` still hand-parse their
query — the generated spec omits those parameters to match.

## Responses are validated from the contract

Each operation declares the bodies it answers with in `responses`, keyed by HTTP
status. `defineEndpoint` holds the handler's response to the schema declared for
that status, after the handler ran. All 21 operations declare `responses` today.
Only a status that writes a body is declared: a 302 redirect and a delete's 204
carry none, so a schema for them would describe something the handler never
writes.

One switch decides what a body that violates its schema is allowed to do:
`responseValidationMode()`, in
`packages/contracts/src/response-validation.ts`.

- `log` — a deployed runtime. The mismatch is logged and the handler's response
  reaches the caller untouched.
- `report` — tests, and every environment that is not a deployed runtime. The
  route answers `500` with `code: "response_contract_mismatch"` and the zod
  issues as `details`, so the bug fails the run that caused it.

A deployed runtime is `NODE_ENV === "production"`, or a Lambda runtime.
`packages/infra/lambda_api.tf` passes only resource names, so the deployed API
function sets no `NODE_ENV`; `AWS_LAMBDA_FUNCTION_NAME` is the signal that
actually holds in production. A preview or staging function therefore logs as
well, and `pnpm test` is the only place a mismatch is reported.

**A contract breach must never turn a working request into a 500 for a user.**
That is the whole reason for the switch. The body is already what the caller
asked for and only its schema is wrong, so the report belongs in the run that
introduced it. `response_contract_mismatch` is absent from the table below
because it never reaches a client.

A new operation must declare `responses`. The registry does not require it, so an
operation that omits it skips response validation and appears in the generated
spec with no response schema.

## Errors are structured

```json
{ "error": { "code": "reconnect_required", "message": "…", "details": [ … ] } }
```

- `code` — stable, machine-readable, snake_case. **This is what clients branch
  on**, not the HTTP status alone and never the prose.
- `message` — human-readable, safe to show a user. Never echo provider internals
  (a Graph error body, an upstream stack); log those instead.
- `details` — present only for request-validation failures, carrying the zod
  issues. Absent otherwise.

Codes in use:

| code                 | status | meaning                                              |
| -------------------- | ------ | ---------------------------------------------------- |
| `unauthorized`       | 401    | missing or invalid credentials                       |
| `invalid_request`    | 400    | body/query/params failed validation (with `details`) |
| `not_found`          | 404    | no such resource, or not visible to this user        |
| `conflict`           | 409    | the request contradicts current state                |
| `no_connection`      | 409    | no stored connection for this user/provider          |
| `reconnect_required` | 409    | the grant is dead; a human must reconnect            |
| `provider_error`     | 502    | the upstream provider failed                         |

The `unauthorized` row is the target, not what ships today. The shared JWT middleware
(`packages/api/src/auth-middleware.ts`) still emits the pre-conventions shape:
`{ "error": "UNAUTHORIZED" }` — flat, and `SCREAMING_SNAKE` rather than a snake_case `code`.
Every JWT-protected route inherits it, including routes that otherwise follow this envelope,
so a client must branch on the 401 status until that middleware returns
`{ "error": { "code": "unauthorized", "message": … } }`.

This is RFC 9457-compatible in spirit (`code` ≈ `type`, `message` ≈ `title`).
Moving to `application/problem+json` later is mechanical, and worth doing only if
a third-party consumer appears.

## Notes

- HTTP status stays the primary signal; `code` disambiguates _within_ a status
  (two 409s above are very different situations for a client).
- A `SettingTab`-style human-facing client should surface `message`; a sync client
  should branch on `code`.
