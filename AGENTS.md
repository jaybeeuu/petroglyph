# Agent Instructions

## Working Documents

Checklists, scratch pads, and other operational notes that should **not** be committed belong in `.working-docs/`. That directory is gitignored.

Never put working documents in `docs/` or any other tracked directory.

## Vocabulary & Verification Gate

- **Glossary**: domain terms — user, provider, connection, profile; identity vs delegation — are
  defined canonically in `.working-docs/glossary.md` (gitignored like all working docs). Use them
  consistently in every plan, bead, doc, PR, and line of new code. When `.working-docs/` is absent
  (fresh worktrees), the definitions live on the bead notes of `petroglyph-6ra.6.1`,
  `petroglyph-oru`, `petroglyph-9jt`, and `6ra.5-redesign-decisions.md` §12.
- **Verification gate (2026-09-06)**: no component is signed off for AFK implementation until its
  service test-plan bead is satisfied — behaviour proven in tests **and** in production,
  integration points verified. Roll through Unit 1 (OneDrive adapter) → Unit 2 (S3 staging) →
  Unit 3 (API/E2E); do not move on until each service's behaviour is confident. Test-plan beads:
  `petroglyph-6ra.5.1.2` (Unit 1), `petroglyph-6ra.5.2.5` (Unit 2), `petroglyph-6ra.7`
  (E2E roll-through — blocks `petroglyph-6ra.4`). The implementation beads under units 1/2 are
  blocked by their plan beads, so they stay out of `bd ready` until the plans are satisfied.

## Pull Request Hygiene

Before asking the user to review or merge a PR, you **must** verify:

1. **Branch is up to date** — rebase onto `main` and force-push if behind.
2. **All CI checks pass** — use `gh run watch <run-id> --exit-status` to confirm build, lint, format, typecheck, and test jobs are green.
3. **Format is clean** — run `pnpm format` locally before committing to avoid format-check failures in CI.

Do not ask the user to merge until all three conditions are met.
