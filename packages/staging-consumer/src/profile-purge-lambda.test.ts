import { describe, expect, it, vi } from "vitest";
import type { DynamoDBRecord, DynamoDBStreamEvent } from "aws-lambda";
import { createProfilePurgeHandler } from "./profile-purge-lambda.js";

function createStreamRecord(options: {
  eventName: "INSERT" | "MODIFY" | "REMOVE";
  sequenceNumber: string;
  newImage?: { [attribute: string]: { S: string } };
  oldImage?: { [attribute: string]: { S: string } };
}): DynamoDBRecord {
  return {
    eventID: `event-${options.sequenceNumber}`,
    eventName: options.eventName,
    eventVersion: "1.1",
    eventSource: "aws:dynamodb",
    awsRegion: "eu-west-2",
    dynamodb: {
      ApproximateCreationDateTime: 1_700_000_000,
      SequenceNumber: options.sequenceNumber,
      SizeBytes: 100,
      StreamViewType: "NEW_AND_OLD_IMAGES",
      ...(options.newImage === undefined ? {} : { NewImage: options.newImage }),
      ...(options.oldImage === undefined ? {} : { OldImage: options.oldImage }),
    },
    eventSourceARN: "arn:aws:dynamodb:eu-west-2:000000000000:table/sync-profiles/stream/x",
  };
}

function createStreamEvent(records: DynamoDBRecord[]): DynamoDBStreamEvent {
  return { Records: records };
}

/** A profile row image, with deletedAt present only when the test asks for it. */
function profileImage(deletedAt?: string): { [attribute: string]: { S: string } } {
  return {
    userId: { S: "user-1" },
    profileId: { S: "profile-1" },
    name: { S: "A profile" },
    ...(deletedAt === undefined ? {} : { deletedAt: { S: deletedAt } }),
  };
}

describe("profile purge handler", () => {
  it("purges the profile a deletion transition names", async () => {
    const purge = vi.fn().mockResolvedValue({ status: "complete" });
    const handler = createProfilePurgeHandler({ purge, log: () => undefined });

    const response = await handler(
      createStreamEvent([
        createStreamRecord({
          eventName: "MODIFY",
          sequenceNumber: "1",
          oldImage: profileImage(),
          newImage: profileImage("2024-05-05T00:00:00.000Z"),
        }),
      ]),
    );

    expect(purge).toHaveBeenCalledWith("profile-1");
    expect(response.batchItemFailures).toEqual([]);
  });

  it("does not purge on a rename, an edit or a later change to a deleted profile", async () => {
    const purge = vi.fn().mockResolvedValue({ status: "complete" });
    const handler = createProfilePurgeHandler({ purge, log: () => undefined });

    const response = await handler(
      createStreamEvent([
        createStreamRecord({
          eventName: "MODIFY",
          sequenceNumber: "1",
          oldImage: profileImage(),
          newImage: { ...profileImage(), name: { S: "Renamed" } },
        }),
        createStreamRecord({
          eventName: "MODIFY",
          sequenceNumber: "2",
          oldImage: profileImage("2024-05-05T00:00:00.000Z"),
          newImage: { ...profileImage("2024-05-05T00:00:00.000Z"), name: { S: "Renamed" } },
        }),
      ]),
    );

    expect(purge).not.toHaveBeenCalled();
    expect(response.batchItemFailures).toEqual([]);
  });

  it("ignores an INSERT and a REMOVE of a profile row", async () => {
    const purge = vi.fn().mockResolvedValue({ status: "complete" });
    const handler = createProfilePurgeHandler({ purge, log: () => undefined });

    const response = await handler(
      createStreamEvent([
        createStreamRecord({ eventName: "INSERT", sequenceNumber: "1", newImage: profileImage() }),
        createStreamRecord({
          eventName: "REMOVE",
          sequenceNumber: "2",
          oldImage: profileImage("2024-05-05T00:00:00.000Z"),
        }),
      ]),
    );

    expect(purge).not.toHaveBeenCalled();
    expect(response.batchItemFailures).toEqual([]);
  });

  it("skips a record whose image carries no usable profileId", async () => {
    const purge = vi.fn().mockResolvedValue({ status: "complete" });
    const handler = createProfilePurgeHandler({ purge, log: () => undefined });

    const response = await handler(
      createStreamEvent([
        createStreamRecord({
          eventName: "MODIFY",
          sequenceNumber: "1",
          oldImage: profileImage(),
          newImage: { deletedAt: { S: "2024-05-05T00:00:00.000Z" } },
        }),
      ]),
    );

    expect(purge).not.toHaveBeenCalled();
    expect(response.batchItemFailures).toEqual([]);
  });

  it("hands an exhausted purge back to the stream", async () => {
    const purge = vi.fn().mockResolvedValue({ status: "exhausted" });
    const handler = createProfilePurgeHandler({ purge, log: () => undefined });

    const response = await handler(
      createStreamEvent([
        createStreamRecord({
          eventName: "MODIFY",
          sequenceNumber: "42",
          oldImage: profileImage(),
          newImage: profileImage("2024-05-05T00:00:00.000Z"),
        }),
      ]),
    );

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "42" }]);
  });

  it("hands a failed purge back to the stream", async () => {
    const purge = vi.fn().mockRejectedValue(new Error("S3 unavailable"));
    const handler = createProfilePurgeHandler({ purge, log: () => undefined });

    const response = await handler(
      createStreamEvent([
        createStreamRecord({
          eventName: "MODIFY",
          sequenceNumber: "43",
          oldImage: profileImage(),
          newImage: profileImage("2024-05-05T00:00:00.000Z"),
        }),
      ]),
    );

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "43" }]);
  });
});
