# Glossary

Canonical vocabulary for the Petroglyph sync redesign. Use these terms consistently in plans,
beads, docs, PRs, and new code — a synonym invented in one place is a concept invented in two.

## Two auth layers, never conflated

- **Identity (layer 1)** — user ↔ Petroglyph. GitHub login and JWT verification, the `GET /status`
  session surface. Deferred and orthogonal to the sync redesign.
- **Delegation (layer 2)** — Petroglyph ↔ provider. The OAuth grant that lets Petroglyph act on a
  user's behalf, its refresh lifecycle, and the Graph calls it authorises.

## Terms

| Term           | Definition                                                                                                                        | Notes                                                                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **User**       | A Petroglyph account holder; the layer-1 identity.                                                                                | `userId` is the JWT `sub` (e.g. `github\|12345`). Internal to Petroglyph — **not** a provider account identifier. Old code misnamed it `tokenHash`.                                                                                                 |
| **Provider**   | A file source Petroglyph can act on a user's behalf against (today: OneDrive; future: GDrive/Dropbox).                            | Stable string identifier (`onedrive`); appears as the `source` URI prefix.                                                                                                                                                                          |
| **Connection** | A user's authorised grant against one provider ("jay's authorised Microsoft account").                                            | One per `(userId, provider)` today. Owns the OAuth token lifecycle and `reconnectRequired`; its existence means connect completed. Revisit trigger: multi-account-per-provider would promote it to a `connectionId` entity that profiles reference. |
| **Profile**    | A sync job: source provider + source directory + destination directory, running over one connection, with `active`/`syncEnabled`. | Keyed `profileId` (`{profileId, userId, source, active, syncEnabled, config?}`); emits events with `source: onedrive://profiles/<profileId>`. Multiple profiles share one connection's tokens.                                                      |
| **Grant**      | The OAuth credential (access + refresh + expiry) held for a connection.                                                           | Microsoft rotates refresh tokens on **every** refresh — a rotated-out copy is dead (`invalid_grant`). Tokens are keyed by connection, never per profile.                                                                                            |

## Sentence checks

- A **user** holds a **connection** to a **provider**; the connection owns the **grant**.
- A **profile** is a scheduled job over one connection; it never holds tokens.
- `userId` is Petroglyph-internal; a provider account id is a different namespace.

## Keyed-by facts

- **Token vault keyed `(userId, provider)` = connection.** The credentialed unit is the
  user × provider grant, so `reconnectRequired` is grant-level — all profiles on a connection
  fast-fail together. Per-profile token copies would rot under Microsoft's refresh-token rotation.
- **Events are per profile** (`onedrive://profiles/<profileId>`) — events are per job, tokens per
  connection.
- **`reconnectRequired` is sticky** until `/onedrive/connect` rewrites the tokens, and
  `resolveAccessToken` never returns an expired token.
