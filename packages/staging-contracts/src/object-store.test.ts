import { describe, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { S3StagedObjectStore, type StagedObjectStoreGetResult } from "./object-store.js";

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
type DeleteObjectsCall = [{ input: { Bucket: string; Delete: { Objects: { Key: string }[] } } }];

/** The keys one `deleteMany` call asked S3 to delete. */
function deleteObjects(send: ReturnType<typeof vi.fn>, index: number): { Key: string }[] {
  const command = (send.mock.calls[index] as DeleteObjectsCall)[0];
  expect(command.input.Bucket).toBe("petroglyph-staged-pdfs");
  return command.input.Delete.Objects;
}

/** Narrow a store get result — get returns null for absent; callers expect present. */
function requireStored(result: StagedObjectStoreGetResult | null): StagedObjectStoreGetResult {
  if (result === null) {
    throw new Error("expected a stored object");
  }
  return result;
}

describe("S3StagedObjectStore", () => {
  it("put stores bytes with the given key and content type, returning the version id", async () => {
    const send = vi.fn().mockResolvedValue({ VersionId: "v-1" });
    const client = { send } as unknown as S3Client;
    const store = new S3StagedObjectStore({
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
    const store = new S3StagedObjectStore({
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
    const store = new S3StagedObjectStore({
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
    const store = new S3StagedObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    await expect(store.get("staging/v1/p1/missing.pdf")).resolves.toBeNull();
  });

  it("get rethrows errors that are not a missing object", async () => {
    const send = vi.fn().mockRejectedValue(new Error("boom"));
    const client = { send } as unknown as S3Client;
    const store = new S3StagedObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    await expect(store.get("staging/v1/p1/a.pdf")).rejects.toThrow("boom");
  });

  it("delete issues a delete request and is idempotent for missing objects", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as S3Client;
    const store = new S3StagedObjectStore({
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

  it("deleteMany deletes in batches of 1000 keys, one request per batch", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as S3Client;
    const store = new S3StagedObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    await store.deleteMany(
      Array.from({ length: 1001 }, (_, index) => `staging/v1/p1/${index}.pdf`),
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(deleteObjects(send, 0)).toHaveLength(1000);
    expect(deleteObjects(send, 1)).toEqual([{ Key: "staging/v1/p1/1000.pdf" }]);
  });

  it("deleteMany fails loudly when S3 refuses a key, rather than counting it as gone", async () => {
    const send = vi.fn().mockResolvedValue({ Errors: [{ Key: "staging/v1/p1/a.pdf" }] });
    const client = { send } as unknown as S3Client;
    const store = new S3StagedObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    await expect(store.deleteMany(["staging/v1/p1/a.pdf"])).rejects.toThrow(
      "S3 refused 1 staged object delete(s)",
    );
  });

  it("presignGet returns a bucket-rooted presigned URL with an expiry and content-disposition override", async () => {
    const send = vi.fn().mockResolvedValue({});
    const client = { send } as unknown as S3Client;
    const store = new S3StagedObjectStore({
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
    const store = new S3StagedObjectStore({
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
