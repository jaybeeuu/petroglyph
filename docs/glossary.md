# Glossary

Canonical vocabulary for the Petroglyph sync redesign. Use these terms consistently in plans,
beads, docs, PRs, and new code — a synonym invented in one place is a concept invented in two.

## Two auth layers, never conflated

- **Identity (layer 1)** — user ↔ Petroglyph. GitHub login and JWT verification, the `GET /status`
  session surface. Deferred and orthogonal to the sync redesign.
- **Delegation (layer 2)** — Petroglyph ↔ provider. The OAuth grant that lets Petroglyph act on a
  user's behalf, its refresh lifecycle, and the Graph calls it authorises.

## Terms

| Term                   | Definition                                                                                                                        | Notes                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User**               | A Petroglyph account holder; the layer-1 identity.                                                                                | `userId` is the JWT `sub` (e.g. `github\|12345`). Internal to Petroglyph — **not** a provider account identifier. Old code misnamed it `tokenHash`.                                                                                                 |
| **Provider**           | A file source Petroglyph can act on a user's behalf against (today: OneDrive; future: GDrive/Dropbox).                            | Stable string identifier (`onedrive`); appears as the `source` URI prefix.                                                                                                                                                                          |
| **Connection**         | A user's authorised grant against one provider ("jay's authorised Microsoft account").                                            | One per `(userId, provider)` today. Owns the OAuth token lifecycle and `reconnectRequired`; its existence means connect completed. Revisit trigger: multi-account-per-provider would promote it to a `connectionId` entity that profiles reference. |
| **Profile**            | A sync job: source provider + source directory + destination directory, running over one connection, with `active`/`syncEnabled`. | Keyed `profileId` (`{profileId, userId, source, active, syncEnabled, config?}`); emits events with `source: onedrive://profiles/<profileId>`. Multiple profiles share one connection's tokens.                                                      |
| **Grant**              | The OAuth credential (access + refresh + expiry) held for a connection.                                                           | Microsoft rotates refresh tokens on **every** refresh — a rotated-out copy is dead (`invalid_grant`). Tokens are keyed by connection, never per profile.                                                                                            |
| **Source folder path** | The provider folder a profile syncs from, stored as `sourceFolderPath`.                                                           | Canonical form, `/` = whole drive. See below.                                                                                                                                                                                                       |

## Sentence checks

- A **user** holds a **connection** to a **provider**; the connection owns the **grant**.
- A **profile** is a scheduled job over one connection; it never holds tokens.
- A profile's **source folder path** is stored in canonical form; `/` is the whole drive, not `""`.
- `userId` is Petroglyph-internal; a provider account id is a different namespace.

## Keyed-by facts

- **`sourceFolderPath` is stored in canonical form** — no leading or trailing slash, no repeated
  slashes (`/notes/a/` → `notes/a`); `/` is the whole drive and `""` is rejected. Graph delta paths
  are always relative to the drive root, so a leading slash makes the walker's prefix match
  unsatisfiable: the profile walks, ingests nothing, and reports a clean run. `normalizeSourceFolderPath`
  in `@petroglyph/core` owns the rule and runs on write and again at walk time.
- **Token vault keyed `(userId, provider)` = connection.** The credentialed unit is the
  user × provider grant, so `reconnectRequired` is grant-level — all profiles on a connection
  fast-fail together. Per-profile token copies would rot under Microsoft's refresh-token rotation.
- **Events are per profile** (`onedrive://profiles/<profileId>`) — events are per job, tokens per
  connection.
- **`reconnectRequired` is sticky** until `/onedrive/connect` rewrites the tokens, and
  `resolveAccessToken` never returns an expired token.

## Active profile

A user has at most one **active** profile: `active` marks the profile the scheduler and the
manual sync path run, and consumers take the first profile with `active: true`. Creating the
first profile, activating a profile through `PUT /profiles/:id`, and deleting the active profile
each adjust the other profiles to keep that invariant.

Activation is read-then-write, not transactional. Two activations that overlap in time can leave
two profiles marked active, and the consumer then runs whichever `listProfiles` returns first.
