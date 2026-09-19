# @petroglyph/event-catalogue

The **build-time** event catalogue: the generated record of every registered event, and the
generator that produces it. See [ARCHITECTURE.md](../../ARCHITECTURE.md#events-registry--staging-contracts)
for why the catalogue is build-time rather than a runtime registry.

## What it provides

- `eventCatalogue` — the generated dispatch table, one `{ type, dataschema, parse }` entry per
  registered event. Consumers that need "all event types" (dispatch, reconciliation) read this.
- `CatalogueEntry` — the entry shape.
- The generator (`generate-catalogue`), which writes both committed artifacts:
  - `packages/events/schemas/<name>/<version>.json` — one draft-2020-12 JSON Schema per event,
    payload-only, `$id` = the event's `dataschema` URI;
  - `src/catalogue.ts` — the dispatch table above.

## Regenerating

```sh
pnpm build                                                  # the generator reads built declaring packages
pnpm --filter @petroglyph/event-catalogue generate-catalogue
pnpm exec prettier --write packages/events/schemas packages/event-catalogue/src/catalogue.ts
```

The `event-catalogue` job in `.github/workflows/validate.yml` runs exactly those commands and fails
on any diff, so a committed artifact can never drift from the declarations. That gate is the only
completeness boundary: it sees every declaring package at once and throws on a duplicate `type`, a
duplicate `dataschema`, or a duplicate `{ type, version }`.

## Declaring events

Registered events are declared with `registerEvent` in the package that owns the domain vocabulary
(today `@petroglyph/staging-contracts`). Each is imported through that package's public surface — a
package publishes its events by exporting them.

`declaringModules` in `src/generate.ts` lists the packages the generator walks, and it is
**hand-maintained**. Adding a package that declares events is a two-part change: export the events
from its public surface, and add the package to `declaringModules`. A package that is not listed is
never walked, so its events are silently absent from the catalogue and the schemas — the gate
cannot fail on an event it never sees. (`petroglyph-j1gn.19` deliverable 2 replaces this list with a
first-class publishing step.)

**Do not edit `src/catalogue.ts` or anything under `packages/events/schemas/` by hand.** Declare the
event in its owning package and regenerate.

## Not here yet

Serving the artifacts from `schemas.petroglyph.dev` is deferred; today the `dataschema` URIs are
recorded contracts, not resolvable URLs. Versioning is still only encoded in the `dataschema`
filename (`petroglyph-j1gn.33`), and the generator reads it back from there.
