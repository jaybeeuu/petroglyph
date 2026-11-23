# Glossary

Canonical vocabulary for the Petroglyph sync redesign. Use these terms consistently in plans,
beads, docs, PRs, and new code — a synonym invented in one place is a concept invented in two.

## Two auth layers, never conflated

- **Identity (layer 1)** — user ↔ Petroglyph. GitHub login and JWT verification, the `GET /status`
  session surface. Deferred and orthogonal to the sync redesign.
- **Delegation (layer 2)** — Petroglyph ↔ provider. The OAuth grant that lets Petroglyph act on a
  user's behalf, its refresh lifecycle, and the Graph calls it authorises.

## Terms

| Term                   | Definition                                                                                                                              | Notes                                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **User**               | A Petroglyph account holder; the layer-1 identity.                                                                                      | `userId` is the JWT `sub` (e.g. `github\|12345`). Internal to Petroglyph — **not** a provider account identifier. Old code misnamed it `tokenHash`.                                                                                                          |
| **Provider**           | A file source Petroglyph can act on a user's behalf against (today: OneDrive; future: GDrive/Dropbox).                                  | Stable string identifier (`onedrive`); appears as the `source` URI prefix.                                                                                                                                                                                   |
| **Connection**         | A user's authorised grant against one provider ("jay's authorised Microsoft account").                                                  | One per `(userId, provider)` today. Owns the OAuth token lifecycle and `reconnectRequired`; its existence means connect completed. Revisit trigger: multi-account-per-provider would promote it to a `connectionId` entity that profiles reference.          |
| **Profile**            | A sync job: source provider + source directory + destination directory, running over one connection, with `active`/`enabled`.           | Keyed `profileId` (`{profileId, userId, source, active, enabled, config?}`); emits events with `source: onedrive://profiles/<profileId>`. Multiple profiles share one connection's tokens.                                                                   |
| **Source folder path** | The provider folder a profile syncs from, stored as `sourceFolderPath`.                                                                 | Stored in canonical form — no leading or trailing slash, no repeated slashes (`/notes/a/` → `notes/a`). `/` is the whole drive, `""` is rejected; a leading slash can never match a delta `relativePath`, which is always relative to the drive root.        |
| **Grant**              | The OAuth credential (access + refresh + expiry) held for a connection.                                                                 | Microsoft rotates refresh tokens on **every** refresh — a rotated-out copy is dead (`invalid_grant`). Tokens are keyed by connection, never per profile.                                                                                                     |
| **Delta cursor**       | The read position one profile's Graph delta walk resumes from: the terminal `@odata.deltaLink` on that profile's row in `delta_tokens`. | Keyed `profileId`, never by connection: a cursor belongs to the walk that advanced it, so a shared row would carry one profile past another's changes. The legacy sync worker's `deltaToken` shares the row as a separate attribute and is **not** a cursor. |

## Sentence checks

- A **user** holds a **connection** to a **provider**; the connection owns the **grant**.
- A **profile** is a scheduled job over one connection; it never holds tokens.
- `userId` is Petroglyph-internal; a provider account id is a different namespace.

## Profile selection

Two stored flags answer two different questions.

- `active` marks the profile the legacy catch-up sweep walks. Exactly one profile per user is active;
  profile create and update maintain it. No files or sync route reads it any more.
- `enabled` marks the profile the delivery feed serves.

Every files and sync request names its profile in the path — `GET /profiles/{id}/files`,
`GET /profiles/{id}/files/{itemId}`, `POST /profiles/{id}/sync-trigger` — so the server resolves the
named row and never picks one. The answer separates the three cases a client must tell apart:

- an unknown profile, or one the caller does not own, answers `404`
- a profile carrying `deletedAt` answers `410 profile_deleted`, from the moment the field is written
- a disabled profile answers `{ files: [], nextToken: null }` on the list and `404` on the download

`410` is not an empty page. A client that pruned on an empty feed would delete every file it had
written for a profile that is gone, so a deleted profile must never look empty.

## Keyed-by facts

- **Token vault keyed `(userId, provider)` = connection.** The credentialed unit is the
  user × provider grant, so `reconnectRequired` is grant-level — all profiles on a connection
  fast-fail together. Per-profile token copies would rot under Microsoft's refresh-token rotation.
- **Events are per profile** (`onedrive://profiles/<profileId>`) — events are per job, tokens per
  connection.
- **Subscription registry keyed `(profileId, provider)` = one Graph subscription per profile.** It is
  the only record of that subscription — root, folder `itemId`, `subscriptionId`, `deltaLink`,
  `clientState` secret, `expiry` and state — so the profile row holds no Graph state. Both indexes
  project ALL because a notification names a `subscriptionId` and nothing else, and the renewer
  reads a time window; either lookup returns `root` and `clientState`, so a recreate needs no
  profile read.
- **`reconnectRequired` is sticky** until `/onedrive/connect` rewrites the tokens, and
  `resolveAccessToken` never returns an expired token.

A profile's `sourceFolderPath` is stored canonically (see the table). The walker
matches it as a raw prefix — `relativePath === rootPath || relativePath.startsWith(rootPath + "/")`
— with `/` special-cased as whole-drive, so an unnormalised value silently matches
nothing.
