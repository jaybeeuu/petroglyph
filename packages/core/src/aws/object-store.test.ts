import { describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { createS3ObjectStore, type ObjectStoreGetResult } from "./object-store.js";

const getSignedUrl =
  vi.fn<(client: unknown, command: unknown, options: unknown) => Promise<string>>();
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: (client: unknown, command: unknown, options: unknown) =>
    getSignedUrl(client, command, options),
}));

interface PutCommandInput {
  Bucket: string;
  Key: string;
  ContentType?: string;
  Body?: Uint8Array;
}

interface GetCommandInput {
  Bucket: string;
  Key: string;
  ResponseContentDisposition?: string;
}

type PutCall = [{ input: PutCommandInput }];
type GetCall = [{ input: GetCommandInput }];

/** Narrow a store get result — get returns null for absent; callers expect present. */
function requireStored(result: ObjectStoreGetResult | null): ObjectStoreGetResult {
  if (result === null) {
    throw new Error("expected a stored object");
  }
  return result;
}

describe("createS3ObjectStore", () => {
  it("put stores bytes with the given key and content type, returning the version id", async () => {
    const send = vi.fn().mockResolvedValue({ VersionId: "v-1" });
    const client = { send } as unknown as S3Client;
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    const result = await store.put("staging/v1/p1/a.pdf", new TextEncoder().encode("pdf-bytes"), {
      contentType: "application/pdf",
    });

    expect(result).toEqual({ versionId: "v-1" });
    expect(send).toHaveBeenCalledTimes(1);
    const command = (send.mock.calls[0] as PutCall)[0];
    expect(command.input).toMatchObject({
      Bucket: "petroglyph-staged-pdfs",
      Key: "staging/v1/p1/a.pdf",
      ContentType: "application/pdf",
    });
    expect(command.input.Body).toEqual(new TextEncoder().encode("pdf-bytes"));
  });

  it("put reports no version id when the bucket is unversioned", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as S3Client;
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    const result = await store.put("staging/v1/p1/a.pdf", new TextEncoder().encode("pdf-bytes"), {
      contentType: "application/pdf",
    });

    expect(result).toEqual({});
  });

  it("get returns stored bytes and etag", async () => {
    const body = {
      transformToByteArray: vi.fn().mockResolvedValue(new TextEncoder().encode("pdf-bytes")),
    };
    const send = vi.fn().mockResolvedValue({ Body: body, ETag: '"abc123"' });
    const client = { send } as unknown as S3Client;
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    const result = requireStored(await store.get("staging/v1/p1/a.pdf"));

    expect(result).toEqual({ body: new TextEncoder().encode("pdf-bytes"), etag: '"abc123"' });
    const command = (send.mock.calls[0] as GetCall)[0];
    expect(command.input).toMatchObject({
      Bucket: "petroglyph-staged-pdfs",
      Key: "staging/v1/p1/a.pdf",
    });
  });

  it("get returns null for a missing object and never throws", async () => {
    const notFound = Object.assign(new Error("Not Found"), { name: "NotFound" });
    const send = vi.fn().mockRejectedValue(notFound);
    const client = { send } as unknown as S3Client;
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    await expect(store.get("staging/v1/p1/missing.pdf")).resolves.toBeNull();
  });

  it("get rethrows errors that are not a missing object", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    const client = { send } as unknown as S3Client;
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    await expect(store.get("staging/v1/p1/a.pdf")).rejects.toThrow("boom");
  });

  it("delete issues a delete request and is idempotent for missing objects", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as S3Client;
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    await store.delete("staging/v1/p1/a.pdf");
    await store.delete("staging/v1/p1/a.pdf");

    expect(send).toHaveBeenCalledTimes(2);
    const command = (send.mock.calls[0] as GetCall)[0];
    expect(command.input).toMatchObject({
      Bucket: "petroglyph-staged-pdfs",
      Key: "staging/v1/p1/a.pdf",
    });
  });

  it("presignGet returns a bucket-rooted presigned URL with an expiry and content-disposition override", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as S3Client;
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    getSignedUrl.mockResolvedValue(
      "https://petroglyph-staged-pdfs.s3.eu-west-2.amazonaws.com/staging/v1/p1/a.pdf?X-Amz-Signature=abc",
    );

    const url = await store.presignGet("staging/v1/p1/a.pdf", {
      ttlSeconds: 120,
      responseContentDisposition: 'attachment; filename="a.pdf"',
    });

    expect(url).toBe(
      "https://petroglyph-staged-pdfs.s3.eu-west-2.amazonaws.com/staging/v1/p1/a.pdf?X-Amz-Signature=abc",
    );
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
    const [presignClient, command, options] = getSignedUrl.mock.calls[0] as unknown as [
      unknown,
      { input: { [key: string]: unknown } },
      { expiresIn: number },
    ];
    expect(presignClient).toBe(client);
    expect(command.input).toMatchObject({
      Bucket: "petroglyph-staged-pdfs",
      Key: "staging/v1/p1/a.pdf",
      ResponseContentDisposition: 'attachment; filename="a.pdf"',
    });
    expect(options.expiresIn).toBe(120);
  });

  it("presignGet defaults the expiry to an hour when not specified", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as S3Client;
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    getSignedUrl.mockResolvedValue("https://presigned.example/url");
    await store.presignGet("staging/v1/p1/a.pdf");

    const options = getSignedUrl.mock.calls.at(-1)?.[2] as { expiresIn: number };
    expect(options.expiresIn).toBe(3600);
  });
});
