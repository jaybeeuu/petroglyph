# Idea: Profile-level file exclude patterns (gitignore-style)

## Status
Backlog idea (not implementation-ready)

## Why it might be useful
Users may want to exclude certain files or folders from being synced — e.g. `.tmp` files, system files (`.DS_Store`, `Thumbs.db`), or specific directories in the watched OneDrive folder. Without this, everything in the watched folder gets pulled into the vault.

## How we might do it
- Add an optional "exclude patterns" field per profile
- Use gitignore-style `.gitignore` pattern matching as the starting point (glob patterns, `!` negation, directory-only with trailing `/`)
- Could even let users point to an actual `.petroglyph-ignore` file in the watched folder, or a text field in the profile settings
- Patterns apply server-side during ingestion (before staging to S3) or client-side during plugin polling
  - Server-side is more efficient (avoids uploading excluded files to S3 entirely)
  - Client-side is simpler to implement but wastes S3 storage on excluded files

## When to think about it
After basic sync is verified and stable. This is a nice-to-have that becomes more important as users put more files in their watched OneDrive folder.

## Priority
Medium-Low (P3/P4). Core sync comes first, but this prevents noise in the vault.

## Notes
- Gitignore-style matching libraries exist for most languages (npm: `ignore`, `micromatch`)
- Consider a `.petroglyph-ignore` file approach for power users who want to version-control their exclude rules
