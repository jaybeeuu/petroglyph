import { describe, expect, it, vi } from "vitest";
import type { Queue } from "@petroglyph/core";
import { fileDeletedEvent, fileStagedEvent } from "@petroglyph/staging-contracts";
import { forwardStreamRecords } from "./forwarder.js";
import type { CloudEvent } from "@petroglyph/events";

function streamRecord(
  recordType: "INSERT" | "MODIFY" | "REMOVE",
  doc: string,
): {
  eventName: string;
  dynamodb: { NewImage?: { doc: { S: string } } };
} {
  return {
    eventName: recordType,
    dynamodb: { NewImage: { doc: { S: doc } } },
  };
}

const stagedDoc = fileStagedEvent.buildDocument({
  id: "emission-1",
  source: "onedrive://profiles/p1",
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
  },
});

const deletedDoc = fileDeletedEvent.buildDocument({
  id: "emission-2",
  source: "onedrive://profiles/p1",
  subject: "files/item-1",
  data: {
    profileId: "p1",
    source: "onedrive",
    changeType: "deleted",
    itemId: "item-1",
    relativePath: "notes/a.pdf",
    s3Key: "staging/v1/p1/notes/a.pdf",
  },
});

const folderDeletedDoc = fileDeletedEvent.buildDocument({
  id: "emission-3",
  source: "onedrive://profiles/p1",
  subject: "files/folder-1",
  data: {
    profileId: "p1",
    source: "onedrive",
    changeType: "deleted",
    itemId: "folder-1",
    relativePath: "notes/sub",
    s3Key: null,
  },
});

interface SendCall {
  message: unknown;
  messageGroupId?: string;
}

function queueSpy(): { queue: Queue<CloudEvent<unknown>>; sends: SendCall[]; errors: string[] } {
  const sends: SendCall[] = [];
  const errors: string[] = [];
  const queue = {
    send: (message: CloudEvent<unknown>, options?: { messageGroupId?: string }): Promise<void> => {
      sends.push({
        message,
        ...(options?.messageGroupId === undefined
          ? {}
          : { messageGroupId: options.messageGroupId }),
      });
      return Promise.resolve();
    },
  };
  return { queue, sends, errors };
}

const json = (doc: CloudEvent<unknown>): string => JSON.stringify(doc);

describe("forwardStreamRecords", () => {
  it("forwards a validated staged event onto the internal queue under its profile group", async () => {
    const { queue, sends } = queueSpy();

    await forwardStreamRecords([streamRecord("INSERT", json(stagedDoc))], { queue });

    expect(sends).toHaveLength(1);
    expect(sends[0]?.messageGroupId).toBe("p1");
    const message = sends[0]?.message as CloudEvent<{ profileId: string; changeType: string }>;
    expect(message.type).toBe("petroglyph.file.staged");
    expect(message.data).toMatchObject({
      profileId: "p1",
      itemId: "item-1",
      s3Key: "staging/v1/p1/notes/a.pdf",
    });
  });

  it("forwards deleted item events (s3Key string) as validated business events", async () => {
    const { queue, sends } = queueSpy();

    await forwardStreamRecords([streamRecord("INSERT", json(deletedDoc))], { queue });

    const message = sends[0]?.message as CloudEvent<{ s3Key: string | null }>;
    expect(message.type).toBe("petroglyph.file.deleted");
    expect(message.data.s3Key).toBe("staging/v1/p1/notes/a.pdf");
  });

  it("preserves folder semantics for path-level deletes (s3Key null)", async () => {
    const { queue, sends } = queueSpy();

    await forwardStreamRecords([streamRecord("INSERT", json(folderDeletedDoc))], { queue });

    const message = sends[0]?.message as CloudEvent<{ s3Key: string | null; relativePath: string }>;
    expect(message.type).toBe("petroglyph.file.deleted");
    expect(message.data.s3Key).toBeNull();
    expect(message.data.relativePath).toBe("notes/sub");
  });

  it("ignores and counts MODIFY/REMOVE rows on the immutable log", async () => {
    const { queue, sends } = queueSpy();

    await forwardStreamRecords(
      [streamRecord("MODIFY", json(stagedDoc)), streamRecord("REMOVE", json(stagedDoc))],
      { queue },
    );

    expect(sends).toHaveLength(0);
  });

  it("skips malformed rows with a loud log and the batch continues", async () => {
    const { queue, sends } = queueSpy();
    const log = vi.fn();

    await forwardStreamRecords(
      [streamRecord("INSERT", "not-json-{{{"), streamRecord("INSERT", json(stagedDoc))],
      { queue, log },
    );

    expect(sends).toHaveLength(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("forward"); // loud log names the offender
  });
});
