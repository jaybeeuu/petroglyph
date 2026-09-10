import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Ajv2020 } from "ajv/dist/2020.js";
import { registerEvent, type RegisteredEvent } from "./registry.js";

const fileStagedDataSchema = z
  .object({
    profileId: z.string().min(1),
    s3Key: z.string().min(1),
  })
  .strict();

function stagedRegistration(): RegisteredEvent<{
  profileId: string;
  s3Key: string;
}> {
  return registerEvent({
    type: "petroglyph.file.staged",
    dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
    dataSchema: fileStagedDataSchema,
  });
}

describe("registerEvent", () => {
  it("binds the registered type and dataschema into every emitted document", () => {
    const registration = stagedRegistration();
    const document = registration.buildDocument({
      source: "onedrive://profiles/p1",
      subject: "files/item-1",
      data: { profileId: "p1", s3Key: "staging/v1/p1/a/b.pdf" },
    });

    expect(document.specversion).toBe("1.0");
    expect(document.type).toBe("petroglyph.file.staged");
    expect(document.dataschema).toBe("https://schemas.petroglyph.dev/file-staged/v1.json");
    expect(document.subject).toBe("files/item-1");
    expect(document.data).toEqual({ profileId: "p1", s3Key: "staging/v1/p1/a/b.pdf" });
    expect(document.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it("generates distinct ids per emission and preserves an explicit id for re-emission", () => {
    const registration = stagedRegistration();
    const data = { profileId: "p1", s3Key: "staging/v1/p1/a/b.pdf" };

    const first = registration.buildDocument({ source: "onedrive://profiles/p1", data });
    const second = registration.buildDocument({ source: "onedrive://profiles/p1", data });

    expect(second.id).not.toBe(first.id);

    const replayed = registration.buildDocument({
      source: "onedrive://profiles/p1",
      id: first.id,
      time: first.time,
      data,
    });
    expect(replayed.id).toBe(first.id);
    expect(replayed.time).toBe(first.time);
  });

  it("parse accepts a document built by the same registration", () => {
    const registration = stagedRegistration();
    const document = registration.buildDocument({
      source: "onedrive://profiles/p1",
      data: { profileId: "p1", s3Key: "staging/v1/p1/a/b.pdf" },
    });

    expect(() => registration.parse(document)).not.toThrow();
  });

  it("parse rejects documents registered under a different type", () => {
    const staged = stagedRegistration();
    const deletedRegistration = registerEvent({
      type: "petroglyph.file.deleted",
      dataschema: "https://schemas.petroglyph.dev/file-deleted/v1.json",
      dataSchema: z
        .object({
          profileId: z.string().min(1),
          s3Key: z.string().nullable(),
        })
        .strict(),
    });
    const document = deletedRegistration.buildDocument({
      source: "onedrive://profiles/p1",
      data: { profileId: "p1", s3Key: null },
    });

    expect(() => staged.parse(document)).toThrow();
  });

  it("parse rejects payload data that fails the data schema", () => {
    const registration = stagedRegistration();
    const document = registration.buildDocument({
      source: "onedrive://profiles/p1",
      data: { profileId: "p1", s3Key: "staging/v1/p1/a/b.pdf" },
    });

    expect(() =>
      registration.parse({ ...document, data: { profileId: "p1", s3Key: "" } }),
    ).toThrow();
  });

  it("emits a JSON-format document whose string form re-parses under the same registration", () => {
    const registration = stagedRegistration();
    const document = registration.buildDocument({
      source: "onedrive://profiles/p1",
      data: { profileId: "p1", s3Key: "staging/v1/p1/a/b.pdf" },
    });

    const reparsed = registration.parse(JSON.parse(registration.format(document)));
    expect(reparsed).toEqual(document);
  });

  it("produces a draft-2020-12 JSON Schema artifact that rejects a missing required field", () => {
    const registration = stagedRegistration();
    const jsonSchema = registration.jsonSchema();

    expect(jsonSchema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");

    const ajv = new Ajv2020();
    const validate = ajv.compile(jsonSchema as object);
    expect(validate({ profileId: "p1", s3Key: "staging/v1/p1/a/b.pdf" })).toBe(true);
    expect(validate({ profileId: "p1" })).toBe(false);
  });
});
