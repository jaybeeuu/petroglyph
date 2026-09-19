import type { CloudEvent } from "@petroglyph/events";

/**
 * One enumerated registered event, as dispatch consumes it. The catalogue is
 * generated (`catalogue.ts`) rather than discovered at runtime: a runtime
 * registry can only ever see the events its own bundle imported, so a build-time
 * table is the only place completeness can be enforced. See
 * [`petroglyph-j1gn.19`](../../../ARCHITECTURE.md#events-registry--staging-contracts).
 */
export interface CatalogueEntry {
  type: string;
  dataschema: string;
  parse(document: unknown): CloudEvent<unknown>;
}
