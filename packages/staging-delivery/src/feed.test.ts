import { describe, expect, it } from "vitest";
import type { ObjectStore } from "@petroglyph/core";
import type { StagedIndexStore, StagedRecord } from "@petroglyph/staging-consumer";
import { DEFAULT_PAGE_SIZE, buildFeed, buildPresignedDisposition } from "./feed.js";

const record: StagedRecord = {
  profileId: "p1",
  itemId: "item-1",
  s3Key: "staging/v1/p1/notes/a.pdf",
  relativePath: "notes",
  name: "a.pdf",
  source: "onedrive",
  mimeType: "application/pdf",
  status: "staged",
  createdAt: "2026-09-01T00:00:00.000Z",
};

function indexSpy(results: { records: StagedRecord[]; nextCursor?: string }): {
  index: StagedIndexStore;
  queries: { profileId: string; limit?: number; cursor?: string }[];
} {
  const queries: { profileId: string; limit?: number; cursor?: string }[] = [];
  const index = {
    queryFeed(options: { profileId: string; limit?: number; cursor?: string }) {
      queries.push(options);
      return Promise.resolve({ ...results });
    },
  } as unknown as StagedIndexStore;
  return { index, queries };
}

function presignSpy(): {
  objectStore: ObjectStore;
  calls: { key: string; ttlSeconds?: number; responseContentDisposition?: string }[];
} {
  const calls: { key: string; ttlSeconds?: number; responseContentDisposition?: string }[] = [];
  const objectStore = {
    presignGet(
      key: string,
      options?: { ttlSeconds?: number; responseContentDisposition?: string },
    ) {
      calls.push({ key, ...options });
      return Promise.resolve(`https://presigned.example/${key}?x=sig`);
    },
  } as unknown as ObjectStore;
  return { objectStore, calls };
}

describe("buildFeed", () => {
  it("returns staged records with a presigned URL from the STORED s3Key verbatim", async () => {
    const { index } = indexSpy({ records: [record] });
    const { objectStore, calls } = presignSpy();

    const result = await buildFeed({ index, objectStore, profileId: "p1" });

    expect(result.files).toEqual([
      {
        itemId: "item-1",
        name: "a.pdf",
        relativePath: "notes",
        mimeType: "application/pdf",
        createdAt: "2026-09-01T00:00:00.000Z",
        s3PresignedUrl: "https://presigned.example/staging/v1/p1/notes/a.pdf?x=sig",
      },
    ]);
    expect(calls).toEqual([
      {
        key: "staging/v1/p1/notes/a.pdf",
        ttlSeconds: 900,
        responseContentDisposition: "attachment; filename*=UTF-8''a.pdf",
      },
    ]);
  });

  it("pages through the index with a limit and passes the next cursor back", async () => {
    const { index, queries } = indexSpy({
      records: [record],
      nextCursor: "item-2",
    });
    const { objectStore } = presignSpy();

    const result = await buildFeed({ index, objectStore, profileId: "p1", limit: 1 });

    expect(queries).toEqual([{ profileId: "p1", limit: 1 }]);
    expect(result.nextToken).toBeDefined();
    const cursor = JSON.parse(
      Buffer.from(result.nextToken ?? "", "base64url").toString("utf8"),
    ) as { profileId: string; itemId: string };
    expect(cursor).toEqual({ profileId: "p1", itemId: "item-2" });
  });

  it("resumes from an index cursor and omits nextToken when exhausted", async () => {
    const { index, queries } = indexSpy({ records: [] });
    const { objectStore } = presignSpy();

    const result = await buildFeed({ index, objectStore, profileId: "p1", cursor: "item-2" });

    expect(queries).toEqual([{ profileId: "p1", limit: DEFAULT_PAGE_SIZE, cursor: "item-2" }]);
    expect(result.files).toEqual([]);
    expect(result.nextToken).toBeNull();
  });
});

describe("buildPresignedDisposition", () => {
  it("encodes the filename for a Content-Disposition attachment override", () => {
    expect(buildPresignedDisposition("a b.pdf")).toBe("attachment; filename*=UTF-8''a%20b.pdf");
  });
});
