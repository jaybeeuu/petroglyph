import { describe, expect, it } from "vitest";
import { continuationDedupeId } from "./delta-trigger.js";

// A real @odata.nextLink is a long opaque URL, far past SQS's 128-character
// deduplication-id limit — which is why the id is a hash of it.
const FIRST_PAGE =
  "https://graph.microsoft.com/v1.0/me/drive/root/delta?$select=id%2Cname%2CeTag%2CparentReference%2Cfile%2Cfolder%2Cdeleted&$skiptoken=page-2-7f3c9a2e-1b4d-4f88-9a10-0c5e2d7b6a41";
const SECOND_PAGE =
  "https://graph.microsoft.com/v1.0/me/drive/root/delta?$select=id%2Cname%2CeTag%2CparentReference%2Cfile%2Cfolder%2Cdeleted&$skiptoken=page-3-2e8f5b10-6c74-4a3d-b8e9-91d4f0a2c573";

// SQS rejects a deduplication id longer than this.
const SQS_DEDUPE_ID_LIMIT = 128;

describe("continuationDedupeId", () => {
  it("gives two different resume links different ids, so one continuation never swallows the other", () => {
    expect(continuationDedupeId(FIRST_PAGE)).not.toBe(continuationDedupeId(SECOND_PAGE));
  });

  it("gives the same resume link the same id, so a repeated send collapses into one continuation", () => {
    expect(continuationDedupeId(SECOND_PAGE)).toBe(continuationDedupeId(SECOND_PAGE));
  });

  it("fits SQS's deduplication-id limit even though the resume link does not", () => {
    expect(FIRST_PAGE.length).toBeGreaterThan(SQS_DEDUPE_ID_LIMIT);
    expect(continuationDedupeId(FIRST_PAGE).length).toBeLessThanOrEqual(SQS_DEDUPE_ID_LIMIT);
  });
});
