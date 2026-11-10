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
