import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCatalogue,
  planCatalogue,
  renderCatalogueModule,
  renderSchemaArtifact,
  schemaArtifactPath,
  writeCataloguePlan,
  type DeclaredEvent,
  type DeclaredEventSource,
} from "./generate.js";

interface RegistrationOverrides {
  type: string;
  dataschema: string;
  jsonSchema?: { [key: string]: unknown };
}

/** The slice of a registration's surface the generator reads. */
interface FakeRegistration {
  type: string;
  dataschema: string;
  parse: (document: unknown) => unknown;
  jsonSchema: () => { [key: string]: unknown };
}

/** A stand-in for what `registerEvent` returns on a declaring package's surface. */
function registration({ type, dataschema, jsonSchema }: RegistrationOverrides): FakeRegistration {
  return {
    type,
    dataschema,
    parse: (document: unknown) => document,
    jsonSchema: () =>
      jsonSchema ?? { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
  };
}

function stagingContracts(namespace: { [exportName: string]: unknown }): DeclaredEventSource {
  return { moduleName: "@petroglyph/staging-contracts", namespace };
}

describe("buildCatalogue", () => {
  it("enumerates the registered events exported by a declaring package", () => {
    const catalogue = buildCatalogue([
      stagingContracts({
        fileStagedEvent: registration({
          type: "petroglyph.file.staged",
          dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
          jsonSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            required: ["s3Key"],
          },
        }),
        // Not a registered event: a payload schema and a plain string are exported alongside.
        fileStagedDataSchema: { type: "object", parse: () => ({}) },
        STAGING_LAYOUT_VERSION: "v1",
      }),
    ]);

    expect(catalogue).toEqual([
      {
        moduleName: "@petroglyph/staging-contracts",
        exportName: "fileStagedEvent",
        type: "petroglyph.file.staged",
        dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
        jsonSchema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          required: ["s3Key"],
        },
      },
    ]);
  });

  it("throws when two events claim the same type and version", () => {
    const duplicate = (): DeclaredEvent[] =>
      buildCatalogue([
        stagingContracts({
          fileStagedEvent: registration({
            type: "petroglyph.file.staged",
            dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
          }),
        }),
        {
          moduleName: "@petroglyph/other-contracts",
          namespace: {
            otherStagedEvent: registration({
              type: "petroglyph.file.staged",
              dataschema: "https://schemas.petroglyph.dev/other/file-staged/v1.json",
            }),
          },
        },
      ]);

    expect(duplicate).toThrow(/Duplicate event type and version: petroglyph\.file\.staged@v1/);
  });

  it("throws when two events claim the same dataschema URI", () => {
    const duplicate = (): DeclaredEvent[] =>
      buildCatalogue([
        stagingContracts({
          fileStagedEvent: registration({
            type: "petroglyph.file.staged",
            dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
          }),
        }),
        {
          moduleName: "@petroglyph/other-contracts",
          namespace: {
            otherStagedEvent: registration({
              type: "petroglyph.file.renamed",
              dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
            }),
          },
        },
      ]);

    expect(duplicate).toThrow(
      /Duplicate dataschema URI: https:\/\/schemas\.petroglyph\.dev\/file-staged\/v1\.json/,
    );
  });

  it("throws when two different versions of one type are declared at once", () => {
    const duplicate = (): DeclaredEvent[] =>
      buildCatalogue([
        stagingContracts({
          fileStagedEvent: registration({
            type: "petroglyph.file.staged",
            dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
          }),
          fileStagedEventV2: registration({
            type: "petroglyph.file.staged",
            dataschema: "https://schemas.petroglyph.dev/file-staged/v2.json",
          }),
        }),
      ]);

    expect(duplicate).toThrow(/Duplicate event type: petroglyph\.file\.staged/);
  });

  it("throws when a declared event's payload schema is not a JSON Schema", () => {
    const catalogue = (): DeclaredEvent[] =>
      buildCatalogue([
        stagingContracts({
          fileStagedEvent: registration({
            type: "petroglyph.file.staged",
            dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
            jsonSchema: { type: "object" },
          }),
        }),
      ]);

    expect(catalogue).toThrow(/expected a JSON Schema object carrying \$schema/);
  });

  it("orders the catalogue by event type so the generated artifacts are deterministic", () => {
    const catalogue = buildCatalogue([
      stagingContracts({
        fileStagedEvent: registration({
          type: "petroglyph.file.staged",
          dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
        }),
        fileDeletedEvent: registration({
          type: "petroglyph.file.deleted",
          dataschema: "https://schemas.petroglyph.dev/file-deleted/v1.json",
        }),
      }),
    ]);

    expect(catalogue.map((event) => event.type)).toEqual([
      "petroglyph.file.deleted",
      "petroglyph.file.staged",
    ]);
  });
});

describe("schemaArtifactPath", () => {
  it("maps a dataschema URI to its path under the schemas root", () => {
    expect(schemaArtifactPath("https://schemas.petroglyph.dev/file-staged/v1.json")).toBe(
      "file-staged/v1.json",
    );
  });
});

describe("renderSchemaArtifact", () => {
  it("pins the dataschema URI as $id over the draft-2020-12 payload schema", () => {
    const artifact = renderSchemaArtifact({
      moduleName: "@petroglyph/staging-contracts",
      exportName: "fileStagedEvent",
      type: "petroglyph.file.staged",
      dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
      jsonSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: ["s3Key"],
      },
    });

    expect(artifact).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://schemas.petroglyph.dev/file-staged/v1.json",
      type: "object",
      required: ["s3Key"],
    });
  });

  it("commits only the keys the payload schema itself declares", () => {
    // zod hangs a non-enumerable `~standard` marker off every schema; a clone
    // would turn it into an enumerable key of the committed artifact.
    const jsonSchema = Object.defineProperty(
      { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
      "~standard",
      { value: { vendor: "zod", version: 1 }, enumerable: false },
    );

    const artifact = renderSchemaArtifact({ ...stagedEvent(), jsonSchema });

    expect(Object.keys(artifact)).toEqual(["$schema", "type", "$id"]);
  });
});

describe("renderCatalogueModule", () => {
  it("imports each declaring package once and parses through the registration", () => {
    const source = renderCatalogueModule([
      {
        moduleName: "@petroglyph/staging-contracts",
        exportName: "fileDeletedEvent",
        type: "petroglyph.file.deleted",
        dataschema: "https://schemas.petroglyph.dev/file-deleted/v1.json",
        jsonSchema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
      },
      {
        moduleName: "@petroglyph/staging-contracts",
        exportName: "fileStagedEvent",
        type: "petroglyph.file.staged",
        dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
        jsonSchema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
      },
    ]);

    expect(source).toContain(
      'import { fileDeletedEvent, fileStagedEvent } from "@petroglyph/staging-contracts";',
    );
    expect(source).toContain("export const eventCatalogue: CatalogueEntry[] = [");
    expect(source).toContain('type: "petroglyph.file.deleted"');
    expect(source).toContain('dataschema: "https://schemas.petroglyph.dev/file-deleted/v1.json"');
    expect(source).toContain("parse: (document) => fileDeletedEvent.parse(document)");
    expect(source).toContain("parse: (document) => fileStagedEvent.parse(document)");
  });
});

function stagedEvent(): DeclaredEvent {
  return {
    moduleName: "@petroglyph/staging-contracts",
    exportName: "fileStagedEvent",
    type: "petroglyph.file.staged",
    dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
    jsonSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" },
  };
}

describe("planCatalogue", () => {
  it("keys each schema artifact by its dataschema path and renders the dispatch table", () => {
    const plan = planCatalogue([stagedEvent()]);

    expect(plan.schemas).toEqual({
      "file-staged/v1.json": {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        $id: "https://schemas.petroglyph.dev/file-staged/v1.json",
      },
    });
    expect(plan.catalogueModule).toContain("export const eventCatalogue: CatalogueEntry[] = [");
  });
});

describe("writeCataloguePlan", () => {
  it("writes every artifact and removes schema files that are no longer declared", async () => {
    const root = await mkdtemp(join(tmpdir(), "event-catalogue-"));
    const paths = {
      schemasRoot: join(root, "schemas"),
      catalogueModule: join(root, "catalogue.ts"),
    };
    await mkdir(join(paths.schemasRoot, "retired"), { recursive: true });
    await writeFile(join(paths.schemasRoot, "retired", "v1.json"), "{}");

    try {
      await writeCataloguePlan(planCatalogue([stagedEvent()]), paths);

      expect(
        JSON.parse(await readFile(join(paths.schemasRoot, "file-staged", "v1.json"), "utf8")),
      ).toEqual({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "https://schemas.petroglyph.dev/file-staged/v1.json",
        type: "object",
      });
      expect(await readFile(paths.catalogueModule, "utf8")).toContain(
        "export const eventCatalogue: CatalogueEntry[] = [",
      );
      await expect(
        readFile(join(paths.schemasRoot, "retired", "v1.json"), "utf8"),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
