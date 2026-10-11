import { describe, expect, it, vi } from "vitest";
import type { SQSEvent, SQSRecord } from "aws-lambda";
import type { CloudEvent } from "@petroglyph/events";
import type {
  FileDeletedData,
  FileStagedData,
  StagedIndexStore,
  StagedObjectStore,
  StagedRecord,
} from "@petroglyph/staging-contracts";
import { createDispatchHandler } from "./dispatch.js";

interface MemIndexStore extends StagedIndexStore {
  records: StagedRecord[];
}

/**
 * In-memory index store — unit fixture matching the interface contract.
 * `failOnItemId` lets a test simulate an apply that throws for one message
 * while the rest of the batch succeeds.
 */
function createMemIndexStore(options: { failOnItemId?: string } = {}): MemIndexStore {
  const records: StagedRecord[] = [];
  return {
    records,
    upsert(record) {
      if (record.itemId === options.failOnItemId) {
        return Promise.reject(new Error("index unavailable"));
      }
      const existing = records.findIndex(
        (r) => r.profileId === record.profileId && r.itemId === record.itemId,
      );
      if (existing >= 0) {
        records.splice(existing, 1, record);
      } else {
        records.push(record);
      }
      return Promise.resolve();
    },
    get(profileId, itemId) {
      return Promise.resolve(
        records.find((r) => r.profileId === profileId && r.itemId === itemId) ?? null,
      );
    },
    remove(profileId, itemId) {
      const index = records.findIndex((r) => r.profileId === profileId && r.itemId === itemId);
      if (index >= 0) records.splice(index, 1);
      return Promise.resolve();
    },
    listUnderPath(profileId, path) {
      return Promise.resolve(
        records.filter(
          (r) =>
            r.profileId === profileId &&
            (r.relativePath === path || r.relativePath.startsWith(`${path}/`)),
        ),
      );
    },
    removeUnderPath(profileId, path) {
      const doomed = records.filter(
        (r) =>
          r.profileId === profileId &&
          (r.relativePath === path || r.relativePath.startsWith(`${path}/`)),
      );
      for (const record of doomed) {
        const index = records.indexOf(record);
        if (index >= 0) records.splice(index, 1);
      }
      return Promise.resolve();
    },
    queryFeed(feedOptions) {
      const page = records.slice(0, feedOptions.limit);
      return Promise.resolve({ records: page });
    },
  };
}

function createObjectStoreSpy(): { objectStore: StagedObjectStore; deletedKeys: string[] } {
  const deletedKeys: string[] = [];
  return {
    deletedKeys,
    objectStore: {
      put: () => Promise.resolve({}),
      get: () => Promise.resolve(null),
      delete: (key) => {
        deletedKeys.push(key);
        return Promise.resolve();
      },
      presignGet: () => Promise.resolve(""),
    },
  };
}

function createStagedDocument(overrides: Partial<FileStagedData> = {}): CloudEvent<FileStagedData> {
  return {
    specversion: "1.0",
    id: "emission-1",
    source: "onedrive://profiles/p1",
    type: "petroglyph.file.staged",
    time: "2026-09-01T00:00:00.000Z",
    datacontenttype: "application/json",
    dataschema: "https://schemas.petroglyph.dev/file-staged/v1.json",
    subject: "files/item-1",
    data: {
      profileId: "p1",
      source: "onedrive",
      changeType: "created",
      itemId: "item-1",
      name: "a.pdf",
      relativePath: "notes",
      s3Key: "staging/v1/p1/notes/a.pdf",
      mimeType: "application/pdf",
      ...overrides,
    },
  };
}

function createDeletedDocument(
  overrides: Partial<FileDeletedData> = {},
): CloudEvent<FileDeletedData> {
  return {
    specversion: "1.0",
    id: "emission-2",
    source: "onedrive://profiles/p1",
    type: "petroglyph.file.deleted",
    time: "2026-09-01T00:00:00.000Z",
    datacontenttype: "application/json",
    dataschema: "https://schemas.petroglyph.dev/file-deleted/v1.json",
    subject: "files/item-1",
    data: {
      profileId: "p1",
      source: "onedrive",
      changeType: "deleted",
      itemId: "item-1",
      relativePath: "notes/a.pdf",
      s3Key: "staging/v1/p1/notes/a.pdf",
      ...overrides,
    },
  };
}

function createSqsRecord(body: string, messageId: string): SQSRecord {
  return {
    messageId,
    receiptHandle: `receipt-${messageId}`,
    body,
    attributes: {
      ApproximateReceiveCount: "1",
      SentTimestamp: "1",
      SenderId: "sender",
      ApproximateFirstReceiveTimestamp: "1",
    },
    messageAttributes: {},
    md5OfBody: "md5",
    eventSource: "aws:sqs",
    eventSourceARN: "arn:aws:sqs:eu-west-2:123456789012:petroglyph-staged-events-production.fifo",
    awsRegion: "eu-west-2",
  };
}

function createSqsEvent(records: SQSRecord[]): SQSEvent {
  return { Records: records };
}

describe("createDispatchHandler", () => {
  it("applies each valid staged event once, preserving receipt order and ignoring redelivery", async () => {
    const store = createMemIndexStore();
    const { objectStore } = createObjectStoreSpy();
    const handler = createDispatchHandler({ index: store, objectStore, log: () => undefined });

    const response = await handler(
      createSqsEvent([
        createSqsRecord(JSON.stringify(createStagedDocument()), "message-1"),
        createSqsRecord(
          JSON.stringify(
            createStagedDocument({ itemId: "item-2", s3Key: "staging/v1/p1/notes/b.pdf" }),
          ),
          "message-2",
        ),
        createSqsRecord(JSON.stringify(createStagedDocument()), "message-3"),
      ]),
    );

    expect(response.batchItemFailures).toEqual([]);
    expect(store.records.map((r) => r.itemId)).toEqual(["item-1", "item-2"]);
    expect(store.records[0]).toMatchObject({
      profileId: "p1",
      s3Key: "staging/v1/p1/notes/a.pdf",
      relativePath: "notes",
      name: "a.pdf",
      status: "staged",
    });
  });

  it("removes the record and deletes the S3 object for a valid deleted event", async () => {
    const store = createMemIndexStore();
    store.records.push({
      profileId: "p1",
      itemId: "item-1",
      s3Key: "staging/v1/p1/notes/a.pdf",
      relativePath: "notes",
      name: "a.pdf",
      source: "onedrive",
      mimeType: "application/pdf",
      status: "staged",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const { objectStore, deletedKeys } = createObjectStoreSpy();
    const handler = createDispatchHandler({ index: store, objectStore, log: () => undefined });

    const response = await handler(
      createSqsEvent([createSqsRecord(JSON.stringify(createDeletedDocument()), "message-1")]),
    );

    expect(response.batchItemFailures).toEqual([]);
    expect(store.records).toEqual([]);
    expect(deletedKeys).toEqual(["staging/v1/p1/notes/a.pdf"]);
  });

  it("fails only the message whose apply throws, applying the rest of the batch", async () => {
    const store = createMemIndexStore({ failOnItemId: "poison" });
    const { objectStore } = createObjectStoreSpy();
    const log = vi.fn();
    const handler = createDispatchHandler({ index: store, objectStore, log });

    const response = await handler(
      createSqsEvent([
        createSqsRecord(JSON.stringify(createStagedDocument()), "message-1"),
        createSqsRecord(
          JSON.stringify(
            createStagedDocument({ itemId: "poison", s3Key: "staging/v1/p1/poison.pdf" }),
          ),
          "message-2",
        ),
        createSqsRecord(
          JSON.stringify(
            createStagedDocument({ itemId: "item-2", s3Key: "staging/v1/p1/notes/b.pdf" }),
          ),
          "message-3",
        ),
      ]),
    );

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "message-2" }]);
    expect(store.records.map((r) => r.itemId)).toEqual(["item-1", "item-2"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("message-2"));
  });

  it("fails a malformed message without applying it and continues the batch", async () => {
    const store = createMemIndexStore();
    const { objectStore } = createObjectStoreSpy();
    const log = vi.fn();
    const handler = createDispatchHandler({ index: store, objectStore, log });

    const response = await handler(
      createSqsEvent([
        createSqsRecord("not-json{", "message-1"),
        createSqsRecord(JSON.stringify({ specversion: "1.0" }), "message-2"),
        createSqsRecord(JSON.stringify(createStagedDocument()), "message-3"),
      ]),
    );

    expect(response.batchItemFailures).toEqual([
      { itemIdentifier: "message-1" },
      { itemIdentifier: "message-2" },
    ]);
    expect(store.records.map((r) => r.itemId)).toEqual(["item-1"]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("malformed staged_events message messageId=message-1"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("malformed staged_events message messageId=message-2"),
    );
  });

  it("logs the identity of every applied event", async () => {
    const store = createMemIndexStore();
    store.records.push({
      profileId: "p1",
      itemId: "item-2",
      s3Key: "staging/v1/p1/notes/b.pdf",
      relativePath: "notes/b.pdf",
      name: "b.pdf",
      source: "onedrive",
      mimeType: "application/pdf",
      status: "staged",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    const { objectStore } = createObjectStoreSpy();
    const log = vi.fn();
    const handler = createDispatchHandler({ index: store, objectStore, log });

    await handler(
      createSqsEvent([
        createSqsRecord(JSON.stringify(createStagedDocument()), "message-1"),
        createSqsRecord(
          JSON.stringify(
            createDeletedDocument({
              itemId: "item-2",
              relativePath: "notes/b.pdf",
              s3Key: "staging/v1/p1/notes/b.pdf",
            }),
          ),
          "message-2",
        ),
      ]),
    );

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("profileId=p1 itemId=item-1 changeType=created"),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("profileId=p1 itemId=item-2 changeType=deleted"),
    );
  });
});
