import { describe, expect, it } from "vitest";
import { isPdf, parseFeed } from "./feed.js";

const page = {
  files: [
    {
      itemId: "smoke-item",
      name: "smoke.pdf",
      relativePath: "notes",
      mimeType: "application/pdf",
      s3PresignedUrl: "https://s3.example.test/signed",
      createdAt: "2026-10-12T00:00:00.000Z",
    },
  ],
  nextToken: null,
};

describe("parseFeed", () => {
  it("returns the page's entries", () => {
    expect(parseFeed(page)).toMatchObject([{ itemId: "smoke-item", name: "smoke.pdf" }]);
  });

  it("rejects a page whose entry is missing its presigned URL", () => {
    expect(() =>
      parseFeed({ files: [{ ...page.files[0], s3PresignedUrl: undefined }], nextToken: null }),
    ).toThrow();
  });
});

describe("isPdf", () => {
  it("accepts a body with the PDF magic bytes", () => {
    expect(isPdf(new TextEncoder().encode("%PDF-1.4\n..."))).toBe(true);
  });

  it("rejects a body without the PDF magic bytes", () => {
    expect(isPdf(new TextEncoder().encode("not a pdf"))).toBe(false);
  });
});
