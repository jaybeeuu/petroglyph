import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileStagedEvent } from "@petroglyph/staging-contracts";
import { describe, expect, it } from "vitest";
import { eventCatalogue, type CatalogueEntry } from "./index.js";
import {
  buildCatalogue,
  defaultCataloguePaths,
  loadDeclaredEventSources,
  renderSchemaArtifact,
  schemaArtifactPath,
  type DeclaredEvent,
} from "./generate.js";

async function declaredEvents(): Promise<DeclaredEvent[]> {
  return buildCatalogue(await loadDeclaredEventSources());
}

function entryFor(type: string): CatalogueEntry {
  const entry = eventCatalogue.find((candidate) => candidate.type === type);
  if (entry === undefined) {
    throw new Error(`no catalogue entry for ${type}`);
  }
  return entry;
}

describe("the committed event catalogue", () => {
  it("holds the regenerated schema artifact for every declared event", async () => {
    const declared = await declaredEvents();
    const { schemasRoot } = defaultCataloguePaths();

    expect(declared.length).toBeGreaterThan(0);
    for (const event of declared) {
      const committed = await readFile(
        join(schemasRoot, schemaArtifactPath(event.dataschema)),
        "utf8",
      );
      expect(JSON.parse(committed)).toEqual(renderSchemaArtifact(event));
    }
  });

  it("holds no schema artifact that no declared event claims", async () => {
    const declared = await declaredEvents();
    const { schemasRoot } = defaultCataloguePaths();

    const committed = (await readdir(schemasRoot, { recursive: true })).filter((entry) =>
      entry.endsWith(".json"),
    );

    expect(committed.toSorted()).toEqual(
      declared.map((event) => schemaArtifactPath(event.dataschema)).toSorted(),
    );
  });

  it("enumerates every declared event in the generated dispatch table", async () => {
    const declared = await declaredEvents();

    expect(
      eventCatalogue.map((entry) => ({ type: entry.type, dataschema: entry.dataschema })),
    ).toEqual(declared.map((event) => ({ type: event.type, dataschema: event.dataschema })));
  });

  it("parses a document through the entry for its own type, and only that entry", () => {
    const document = fileStagedEvent.buildDocument({
      id: "emission-1",
      source: "onedrive://profiles/p1",
      data: {
        profileId: "p1",
        source: "onedrive",
        changeType: "created",
        itemId: "item-1",
        name: "note.pdf",
        relativePath: "a/b",
        s3Key: "staging/v1/p1/a/b/note.pdf",
        mimeType: "application/pdf",
      },
    });

    expect(entryFor("petroglyph.file.staged").parse(document)).toEqual(document);
    expect(() => entryFor("petroglyph.file.deleted").parse(document)).toThrow();
  });
});
