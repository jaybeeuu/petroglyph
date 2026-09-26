import { describe, expect, it } from "vitest";
import type { CloudEvent } from "@petroglyph/events";
import {
  type FileDeletedData,
  type FileStagedData,
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

const createStagedDocument = (
  overrides: Partial<CloudEvent<FileStagedData>> = {},
): CloudEvent<FileStagedData> => ({
  specversion: "1.0",
  id: "emission-1",
  source: "onedrive://profiles/p1",
  type: "petroglyph.file.staged",
  time: "2026-09-03T12:00:00Z",
  datacontenttype: "application/json",
  dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
  subject: "files/item-1",
  data: stagedData,
  ...overrides,
});

const createDeletedDocument = (
  overrides: Partial<CloudEvent<FileDeletedData>> = {},
): CloudEvent<FileDeletedData> => ({
  specversion: "1.0",
  id: "emission-2",
  source: "onedrive://profiles/p1",
  type: "petroglyph.file.deleted",
  time: "2026-09-03T12:00:00Z",
  datacontenttype: "application/json",
  dataschema: "https://schemas.petroglyph.dev/file-deleted/v1.json",
  subject: "files/item-1",
  data: deletedData,
  ...overrides,
});

describe("fileStagedEvent", () => {
  it("parses a conformant CloudEvent document", () => {
    expect(fileStagedEvent.parse(createStagedDocument())).toMatchObject({
      specversion: "1.0",
      type: "petroglyph.file.staged",
      dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
      data: stagedData,
    });
  });

  it("rejects a document carrying a foreign type literal", () => {
    expect(() =>
      fileStagedEvent.parse(createStagedDocument({ type: "petroglyph.file.deleted" })),
    ).toThrow();
  });

  it("rejects a document carrying a foreign dataschema literal", () => {
    expect(() =>
      fileStagedEvent.parse(
        createStagedDocument({ dataschema: "https://schemas.petroglyph.dev/other/v1.json" }),
      ),
    ).toThrow();
  });

  it("rejects bad envelopes (missing id, non-RFC3339 time)", () => {
    const { id: _id, ...withoutId } = createStagedDocument();
    expect(() => fileStagedEvent.parse(withoutId)).toThrow();
    expect(() =>
      fileStagedEvent.parse({ ...withoutId, id: "emission-1", time: "yesterday" }),
    ).toThrow();
  });
});

describe("fileDeletedEvent", () => {
  it("parses a conformant CloudEvent document", () => {
    expect(fileDeletedEvent.parse(createDeletedDocument())).toMatchObject({
      specversion: "1.0",
      type: "petroglyph.file.deleted",
      dataschema: "https://schemas.petroglyph.dev/file-deleted/v1.json",
      data: deletedData,
    });
  });

  it("a staged document never parses as deleted and vice versa", () => {
    expect(() => fileDeletedEvent.parse(createStagedDocument())).toThrow();
    expect(() => fileStagedEvent.parse(createDeletedDocument())).toThrow();
  });
});

describe("change-type schemas", () => {
  it("are the advertised literals", () => {
    expect(stagedChangeTypeSchema.options).toEqual(["created", "updated"]);
    expect(deletedChangeTypeSchema.parse("deleted")).toBe("deleted");
  });
});
