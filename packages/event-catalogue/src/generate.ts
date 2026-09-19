import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** A declaring package's public surface, as the generator sees it. */
export interface DeclaredEventSource {
  moduleName: string;
  namespace: { [exportName: string]: unknown };
}

/** A registered event enumerated from a declaring package. */
export interface DeclaredEvent {
  moduleName: string;
  exportName: string;
  type: string;
  dataschema: string;
  jsonSchema: { [key: string]: unknown };
}

const registeredEventShape = z.object({
  type: z.string().min(1),
  dataschema: z.string().min(1),
  parse: z.custom<(...args: never[]) => unknown>((value) => typeof value === "function"),
  jsonSchema: z.custom<() => unknown>((value) => typeof value === "function"),
});

type RegisteredEventShape = z.infer<typeof registeredEventShape>;

/** The header every draft-artifact payload schema carries. */
const jsonSchemaHeader = z.object({ $schema: z.string().min(1) });

/**
 * A payload JSON Schema as a registration's `jsonSchema()` returns it. `z.custom`
 * passes the value through untouched — cloning it would promote zod's
 * non-enumerable `~standard` marker into the committed artifact.
 */
const payloadSchemaShape = z.custom<{ [key: string]: unknown }>(
  (value) => jsonSchemaHeader.safeParse(value).success,
  { error: "expected a JSON Schema object carrying $schema" },
);

/**
 * The path a dataschema URI maps to, relative to the schemas root
 * (`https://schemas.petroglyph.dev/file-staged/v1.json` -> `file-staged/v1.json`).
 * The URI is the only key an artifact has today; deriving the path from it keeps
 * the artifact layout independent of how the catalogue models versions.
 */
export function schemaArtifactPath(dataschema: string): string {
  return new URL(dataschema).pathname.replace(/^\//, "");
}

/**
 * The version an event declares. Today it only exists inside the dataschema
 * filename, so it is read back from there — the one place that knows this, and
 * the place petroglyph-j1gn.33 changes when versioning becomes structural.
 */
function declaredVersion(event: DeclaredEvent): string {
  const filename = schemaArtifactPath(event.dataschema).split("/").at(-1) ?? "";
  return filename.replace(/\.json$/, "");
}

function assertUnique(
  events: readonly DeclaredEvent[],
  keyOf: (event: DeclaredEvent) => string,
  describe: string,
): void {
  const claimedBy = new Map<string, string>();
  for (const event of events) {
    const key = keyOf(event);
    const previous = claimedBy.get(key);
    if (previous !== undefined) {
      throw new Error(
        `Duplicate ${describe}: ${key} is claimed by ${previous} and ` +
          `${event.moduleName}#${event.exportName}.`,
      );
    }
    claimedBy.set(key, `${event.moduleName}#${event.exportName}`);
  }
}

/** An export that advertises a registered event's identity, whatever else it carries. */
function claimsEventIdentity(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown })["type"] === "string" &&
    typeof (value as { dataschema?: unknown })["dataschema"] === "string"
  );
}

function isRegisteredEvent(value: unknown): value is RegisteredEventShape {
  return registeredEventShape.safeParse(value).success;
}

export function buildCatalogue(sources: readonly DeclaredEventSource[]): DeclaredEvent[] {
  const events: DeclaredEvent[] = [];

  for (const source of sources) {
    for (const [exportName, value] of Object.entries(source.namespace)) {
      if (!claimsEventIdentity(value)) {
        continue;
      }
      if (!isRegisteredEvent(value)) {
        throw new Error(
          `${source.moduleName} exports ${exportName}, which names a registered event but is not one: ` +
            "a registered event carries `type`, `dataschema`, `parse`, and `jsonSchema`.",
        );
      }
      events.push({
        moduleName: source.moduleName,
        exportName,
        type: value.type,
        dataschema: value.dataschema,
        jsonSchema: payloadSchemaShape.parse(value.jsonSchema()),
      });
    }
  }

  assertUnique(
    events,
    (event) => `${event.type}@${declaredVersion(event)}`,
    "event type and version",
  );
  assertUnique(events, (event) => event.dataschema, "dataschema URI");
  assertUnique(events, (event) => event.type, "event type");

  return events.toSorted((left, right) => left.type.localeCompare(right.type));
}

/** A payload schema committed under the schemas root, keyed by its dataschema URI. */
export type SchemaArtifact = { $id: string } & { [key: string]: unknown };

/**
 * The committed artifact is payload-only: the event's own payload schema with
 * the dataschema URI pinned as `$id`, so a file names the contract it records.
 */
export function renderSchemaArtifact(event: DeclaredEvent): SchemaArtifact {
  return { ...event.jsonSchema, $id: event.dataschema };
}

/** Each entry as its own chunk, so the array can be spread into the module. */
function renderCatalogueEntries(events: readonly DeclaredEvent[]): string[] {
  return events.map((event) =>
    [
      "  {",
      `    type: ${JSON.stringify(event.type)},`,
      `    dataschema: ${JSON.stringify(event.dataschema)},`,
      `    parse: (document) => ${event.exportName}.parse(document),`,
      "  },",
    ].join("\n"),
  );
}

function renderImport(moduleName: string, events: readonly DeclaredEvent[]): string {
  const exportNames = events
    .filter((event) => event.moduleName === moduleName)
    .map((event) => event.exportName);
  return `import { ${exportNames.join(", ")} } from "${moduleName}";`;
}

/**
 * The generated dispatch table: one entry per registered event, each parsing
 * through the registration that declares it. A new event type needs no consumer
 * change — it only needs this module regenerated.
 */
export function renderCatalogueModule(events: readonly DeclaredEvent[]): string {
  const declaringModules = [...new Set(events.map((event) => event.moduleName))];

  return [
    "// Generated by `pnpm --filter @petroglyph/event-catalogue generate-catalogue`.",
    "// Do not edit by hand: declare the event in its owning package and regenerate.",
    'import type { CatalogueEntry } from "./catalogue-entry.js";',
    ...declaringModules.map((moduleName) => renderImport(moduleName, events)),
    "",
    "export const eventCatalogue: CatalogueEntry[] = [",
    ...renderCatalogueEntries(events),
    "];",
    "",
  ].join("\n");
}

/** Everything the generator commits, in the shape it is written to git. */
export interface CataloguePlan {
  /** Schema artifacts keyed by path relative to the schemas root. */
  schemas: { [relativePath: string]: SchemaArtifact };
  /** Source of the generated dispatch-table module. */
  catalogueModule: string;
}

export function planCatalogue(events: readonly DeclaredEvent[]): CataloguePlan {
  const schemas: { [relativePath: string]: SchemaArtifact } = {};
  for (const event of events) {
    schemas[schemaArtifactPath(event.dataschema)] = renderSchemaArtifact(event);
  }
  return { schemas, catalogueModule: renderCatalogueModule(events) };
}

/** Where the generated artifacts are committed. */
export interface CataloguePaths {
  schemasRoot: string;
  catalogueModule: string;
}

/**
 * The declaration side of the catalogue: the packages the generator walks. This
 * is the seed of the mechanism petroglyph-j1gn.19 deliverable 2 replaces — a
 * package is listed here until publishing its events becomes a first-class step.
 */
export const declaringModules: readonly string[] = ["@petroglyph/staging-contracts"];

export function defaultCataloguePaths(): CataloguePaths {
  return {
    schemasRoot: fileURLToPath(new URL("../../events/schemas/", import.meta.url)),
    catalogueModule: fileURLToPath(new URL("./catalogue.ts", import.meta.url)),
  };
}

export interface WriteReport {
  /** Schema artifact paths, relative to the schemas root, that were written. */
  written: string[];
  /** Schema artifact paths that no declared event claims any more. */
  removed: string[];
}

async function removeOrphanArtifacts(
  schemasRoot: string,
  declaredPaths: ReadonlySet<string>,
): Promise<string[]> {
  const entries = await readdir(schemasRoot, { recursive: true, withFileTypes: true });
  const removed: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const artifact = join(entry.parentPath, entry.name);
    const relativePath = relative(schemasRoot, artifact);
    if (declaredPaths.has(relativePath)) {
      continue;
    }
    await rm(artifact);
    removed.push(relativePath);
  }

  return removed;
}

/**
 * Writes the plan and prunes artifacts no longer declared, so the committed
 * schemas stay exactly the registered events — the completeness guarantee the
 * regenerate-and-diff CI gate rests on.
 */
export async function writeCataloguePlan(
  plan: CataloguePlan,
  paths: CataloguePaths,
): Promise<WriteReport> {
  await mkdir(paths.schemasRoot, { recursive: true });

  const written: string[] = [];
  for (const [relativePath, artifact] of Object.entries(plan.schemas)) {
    const artifactPath = join(paths.schemasRoot, relativePath);
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    written.push(relativePath);
  }

  await mkdir(dirname(paths.catalogueModule), { recursive: true });
  await writeFile(paths.catalogueModule, plan.catalogueModule);

  return { written, removed: await removeOrphanArtifacts(paths.schemasRoot, new Set(written)) };
}

/**
 * A module's public surface as export name -> value. An ESM namespace carries a
 * `Symbol.toStringTag` own key beside its string-keyed exports, so its entries are
 * read explicitly instead of being validated as a whole.
 */
function declaredEventNamespace(module: object): { [exportName: string]: unknown } {
  return Object.fromEntries(
    Object.entries(module).map(([exportName, value]): [string, unknown] => [exportName, value]),
  );
}

export async function loadDeclaredEventSources(): Promise<DeclaredEventSource[]> {
  return Promise.all(
    declaringModules.map(async (moduleName) => {
      const module: unknown = await import(moduleName);
      if (typeof module !== "object" || module === null) {
        throw new Error(`${moduleName} did not import as a module namespace.`);
      }
      return { moduleName, namespace: declaredEventNamespace(module) };
    }),
  );
}

/** Walks the declaring packages and regenerates every committed artifact. */
export async function regenerateCatalogue(
  paths: CataloguePaths = defaultCataloguePaths(),
): Promise<WriteReport> {
  const plan = planCatalogue(buildCatalogue(await loadDeclaredEventSources()));
  return writeCataloguePlan(plan, paths);
}
