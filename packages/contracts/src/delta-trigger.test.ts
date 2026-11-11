import { describe, expect, it } from "vitest";
import { createDeltaTriggerSend, deltaTriggerSchema } from "./delta-trigger.js";

const QUEUE_URL = "https://sqs.eu-west-2.amazonaws.com/000000000000/petroglyph-delta-trigger.fifo";

describe("createDeltaTriggerSend", () => {
  it("addresses one bell to the connection's FIFO group with the bell body", () => {
    const send = createDeltaTriggerSend({
      queueUrl: QUEUE_URL,
      bell: { userId: "user-42", provider: "onedrive" },
      dedupeIdentity: "user-42:onedrive",
    });

    expect(send).toStrictEqual({
      QueueUrl: QUEUE_URL,
      MessageBody: '{"userId":"user-42","provider":"onedrive"}',
      MessageGroupId: "user-42:onedrive",
      MessageDeduplicationId: "c2625eb14db11cc783364593e64f35ebeec99954e4a1956319e367541956046f",
    });
  });

  it("writes a body the adapter's delta-trigger schema accepts", () => {
    const send = createDeltaTriggerSend({
      queueUrl: QUEUE_URL,
      bell: { userId: "user-42", provider: "onedrive" },
      dedupeIdentity: "user-42:onedrive",
    });

    expect(deltaTriggerSchema.parse(JSON.parse(send.MessageBody))).toStrictEqual({
      userId: "user-42",
      provider: "onedrive",
    });
  });

  it("gives two sends of one identity the same deduplication id, and other identities another", () => {
    const first = createDeltaTriggerSend({
      queueUrl: QUEUE_URL,
      bell: { userId: "user-42", provider: "onedrive" },
      dedupeIdentity: "user-42:onedrive",
    });
    const repeat = createDeltaTriggerSend({
      queueUrl: QUEUE_URL,
      bell: { userId: "user-42", provider: "onedrive" },
      dedupeIdentity: "user-42:onedrive",
    });
    const later = createDeltaTriggerSend({
      queueUrl: QUEUE_URL,
      bell: { userId: "user-42", provider: "onedrive" },
      dedupeIdentity: "user-42:onedrive:1700000000",
    });

    expect(repeat.MessageDeduplicationId).toBe(first.MessageDeduplicationId);
    expect(later.MessageDeduplicationId).toBe(
      "6cc5cd10b7b9da5904cd601702da6740666a4cd676ba6838e7a17f39bbfe8a4d",
    );
  });
});
