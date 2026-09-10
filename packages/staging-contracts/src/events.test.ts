import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  fileDeletedDataSchema,
  fileDeletedEvent,
  fileStagedDataSchema,
  fileStagedEvent,
  stagedChangeTypeSchema,
  deletedChangeTypeSchema,
} from "./events.js";

const stagedData = {
  profileId: "p1",
  source: "onedrive",
  changeType: "created" as const,
  itemId: "item-1",
  name: "note.pdf",
  relativePath: "a/b",
  s3Key: "staging/v1/p1/a/b/note.pdf",
  mimeType: "application/pdf",
};

const deletedData = {
  profileId: "p1",
  source: "onedrive",
  changeType: "deleted" as const,
  itemId: "item-1",
  relativePath: "a/b",
  s3Key: null,
};

describe("fileStagedDataSchema", () => {
  it("parses a valid staged payload", () => {
    expect(fileStagedDataSchema.parse(stagedData)).toEqual(stagedData);
  });

  it("requires an non-empty s3Key", () => {
    expect(() => fileStagedDataSchema.parse({ ...stagedData, s3Key: "" })).toThrow();
    expect(() => fileStagedDataSchema.parse({ ...stagedData, s3Key: null })).toThrow();
  });

  it("requires mimeType", () => {
    const { mimeType: _mimeType, ...withoutMimeType } = stagedData;
    expect(() => fileStagedDataSchema.parse(withoutMimeType)).toThrow();
  });

  it("rejects the deleted changeType (cross-reject)", () => {
    expect(() => fileStagedDataSchema.parse({ ...stagedData, changeType: "deleted" })).toThrow();
  });

  it("rejects unknown change types", () => {
    expect(() => fileStagedDataSchema.parse({ ...stagedData, changeType: "renamed" })).toThrow();
  });

  it("rejects OneDrive-shaped fields in strict mode", () => {
    expect(() =>
      fileStagedDataSchema.parse({ ...stagedData, parentReference: { driveId: "d1" } }),
    ).toThrow();
    expect(() => fileStagedDataSchema.parse({ ...stagedData, tokenHash: "user-1" })).toThrow();
  });
});

describe("fileDeletedDataSchema", () => {
  it("parses a deleted payload with a null s3Key", () => {
    expect(fileDeletedDataSchema.parse(deletedData)).toEqual(deletedData);
  });

  it("parses a deleted payload carrying the removed s3Key", () => {
    const withKey = { ...deletedData, s3Key: "staging/v1/p1/a/b/note.pdf" };
    expect(fileDeletedDataSchema.parse(withKey)).toEqual(withKey);
  });

  it("rejects non-deleted change types", () => {
    expect(() => fileDeletedDataSchema.parse({ ...deletedData, changeType: "created" })).toThrow();
  });

  it("rejects OneDrive-shaped fields in strict mode", () => {
    expect(() =>
      fileDeletedDataSchema.parse({ ...deletedData, driveItem: { id: "item-1" } }),
    ).toThrow();
  });
});

describe("registered events", () => {
  it("registers the brand-anchored types with schemas.petroglyph.dev dataschemas", () => {
    expect(fileStagedEvent.type).toBe("petroglyph.file.staged");
    expect(fileStagedEvent.dataschema).toBe("https://schemas.petroglyph.dev/file-staged/v1.json");
    expect(fileDeletedEvent.type).toBe("petroglyph.file.deleted");
    expect(fileDeletedEvent.dataschema).toBe("https://schemas.petroglyph.dev/file-deleted/v1.json");
  });

  it("emits a conformant CE document that round-trips through parse", () => {
    const document = fileStagedEvent.buildDocument({
      source: "onedrive://profiles/p1",
      subject: "files/item-1",
      data: stagedData,
    });

    expect(document.specversion).toBe("1.0");
    expect(document.type).toBe("petroglyph.file.staged");
    expect(document.source).toBe("onedrive://profiles/p1");
    expect(document.dataschema).toBe("https://schemas.petroglyph.dev/file-staged/v1.json");
    expect(document.subject).toBe("files/item-1");
    expect(document.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);

    const reparsed = fileStagedEvent.parse(JSON.parse(fileStagedEvent.format(document)));
    expect(reparsed).toEqual(document);
  });

  it("a staged document never parses as deleted and vice versa", () => {
    const staged = fileStagedEvent.buildDocument({
      source: "onedrive://profiles/p1",
      data: stagedData,
    });
    const deleted = fileDeletedEvent.buildDocument({
      source: "onedrive://profiles/p1",
      data: deletedData,
    });

    expect(() => fileDeletedEvent.parse(staged)).toThrow();
    expect(() => fileStagedEvent.parse(deleted)).toThrow();
  });

  it("rejects bad envelopes (missing id, non-RFC3339 time)", () => {
    const { id: _id, ...withoutId } = fileStagedEvent.buildDocument({
      source: "onedrive://profiles/p1",
      data: stagedData,
    });
    expect(() => fileStagedEvent.parse(withoutId)).toThrow();
    expect(() => fileStagedEvent.parse({ ...withoutId, id: "x", time: "yesterday" })).toThrow();
  });

  it("produces JSON Schema artifacts that validate conformant data and reject missing s3Key", () => {
    const ajv = new Ajv2020();
    const validate = ajv.compile(fileStagedEvent.jsonSchema() as object);

    expect(validate(stagedData)).toBe(true);
    const { s3Key: _s3Key, ...withoutKey } = stagedData;
    expect(validate(withoutKey)).toBe(false);
  });

  it("the change-type schemas are the advertised literals", () => {
    expect(stagedChangeTypeSchema.options).toEqual(["created", "updated"]);
    expect(deletedChangeTypeSchema.parse("deleted")).toBe("deleted");
  });
});
