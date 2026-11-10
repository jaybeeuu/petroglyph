# API conventions

The response envelope, decided 2026-11-05 (`petroglyph-m0jc.1`). These rules are
adopted surface by surface, not repo-wide, so a route that predates a rule may
still break it. Where a route is known to break a rule, this document says so
next to that rule. `GET /files/changes` is the known exception to the cursor and
strict-query rule below.

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
back verbatim as `?nextToken=`; never parse it, never derive it. Request and
response use one name for the cursor, so a consumer can echo the response field
without translating it. `nextToken` keeps its name — it is already implemented,
the token is opaque, and renaming it to `next_page_token` would be a client
change for no gain.

A collection route declares its query parameters strictly. An unknown or
misspelled parameter is rejected with 400, never stripped: a wrong cursor name
must not degrade to "start again from page 1".

Strictness is necessary but not sufficient. A handler that reads named keys —
`c.req.query("nextToken")`, `c.req.query("limit")` — and hands zod an object
built from them drops a misspelled key before zod sees it, so `.strict()` alone
cannot catch the mistake. Validate the whole query object (`c.req.query()`) so
the schema sees exactly what the client sent.

### Known exception: `GET /files/changes`

`GET /files/changes` breaks both halves of the rule above, and the two breaks
compound into a silent loop:

- it takes the cursor as `?after=`, but returns it in a field named `nextToken`,
  so a caller that echoes the response field sends `?nextToken=`;
- its query schema is not strict, and the handler builds the parse input from
  named keys (`c.req.query("after")`, `c.req.query("limit")`), so an unknown or
  misspelled parameter is dropped before validation;
- the ignored cursor means page 1 on every call, with no error to reveal it.

The route is `deprecated: true` in the contracts registry and is due for removal
under `petroglyph-m0jc.3` (old-surface retirement), so its response field will
not be renamed. The defect is tracked by `petroglyph-9c77` and will be fixed or
retired with that bead. Do not build a new caller on it; use `GET /files`.

## `meta` is reserved

`meta` is for cross-cutting data only — request correlation, deprecation notices.
It is never used to carry payload, and a payload key may not be named `meta`.

```json
{ "files": [ … ], "nextToken": null, "meta": { "requestId": "01J…" } }
```

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
