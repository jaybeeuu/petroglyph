import { describe, expect, it } from "vitest";
import { z } from "zod";
import { cloudEventSchema, formatCloudEvent, parseCloudEvent } from "./cloud-event.js";

const happyEnvelope = {
  specversion: "1.0" as const,
  id: "75bcad3e-9e61-4f2e-9f4d-1f48f723c186",
  source: "onedrive://profiles/p1",
  type: "petroglyph.file.staged",
  time: "2026-09-03T12:00:00Z",
  datacontenttype: "application/json",
  dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
  subject: "files/item-1",
  data: { profileId: "p1", s3Key: "staging/v1/p1/a/b.pdf" },
};

describe("cloudEventSchema", () => {
  it("round-trips a conforming CE 1.0.2 document via parse and format", () => {
    const envelopeSchema = cloudEventSchema(z.object({ profileId: z.string(), s3Key: z.string() }));
    const parsed = parseCloudEvent(happyEnvelope, envelopeSchema);
    const formatted = formatCloudEvent(parsed);

    expect(parsed.specversion).toBe("1.0");
    expect(parsed.id).toBe("75bcad3e-9e61-4f2e-9f4d-1f48f723c186");
    expect(parsed.type).toBe("petroglyph.file.staged");
    expect(parsed.data).toEqual({ profileId: "p1", s3Key: "staging/v1/p1/a/b.pdf" });

    const reparsed = parseCloudEvent(JSON.parse(formatted), envelopeSchema);
    expect(reparsed).toEqual(parsed);
  });

  it("rejects an envelope with a non-1.0 specversion", () => {
    const envelopeSchema = cloudEventSchema(z.unknown());
    expect(() =>
      parseCloudEvent({ ...happyEnvelope, specversion: "0.3" }, envelopeSchema),
    ).toThrow();
  });

  it("rejects a missing id", () => {
    const envelopeSchema = cloudEventSchema(z.unknown());
    const { id: _id, ...withoutId } = happyEnvelope;
    expect(() => parseCloudEvent(withoutId, envelopeSchema)).toThrow();
  });

  it("rejects a non-RFC3339 time", () => {
    const envelopeSchema = cloudEventSchema(z.unknown());
    expect(() =>
      parseCloudEvent({ ...happyEnvelope, time: "2026-09-03" }, envelopeSchema),
    ).toThrow();
  });

  it("rejects a relative dataschema URI", () => {
    const envelopeSchema = cloudEventSchema(z.unknown());
    expect(() =>
      parseCloudEvent({ ...happyEnvelope, dataschema: "/file-staged/v1.json" }, envelopeSchema),
    ).toThrow();
  });

  it("rejects a missing data payload", () => {
    const envelopeSchema = cloudEventSchema(z.object({ profileId: z.string() }));
    const { data: _data, ...withoutData } = happyEnvelope;
    expect(() => parseCloudEvent(withoutData, envelopeSchema)).toThrow();
  });

  it("rejects data that fails the bound payload schema", () => {
    const envelopeSchema = cloudEventSchema(z.object({ profileId: z.string().min(1) }));
    expect(() =>
      parseCloudEvent({ ...happyEnvelope, data: { profileId: "" } }, envelopeSchema),
    ).toThrow();
  });
});
