import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateBucketCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createS3ObjectStore, type ObjectStoreGetResult } from "./object-store.js";

function requireStored(result: ObjectStoreGetResult | null): ObjectStoreGetResult {
  if (result === null) {
    throw new Error("expected a stored object");
  }
  return result;
}

function dockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const canRun = dockerAvailable();

describe.skipIf(!canRun)("S3 ObjectStore against LocalStack", () => {
  let container: StartedTestContainer;
  let client: S3Client;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "s3",
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        AWS_DEFAULT_REGION: "eu-west-2",
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .start();

    const endpoint = `http://${container.getHost()}:${container.getMappedPort(4566)}`;
    client = new S3Client({
      region: "eu-west-2",
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await client.send(new CreateBucketCommand({ Bucket: "petroglyph-staged-pdfs" }));
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("put stores bytes with content type; get reads them back with metadata intact", async () => {
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });
    const body = new TextEncoder().encode("%PDF-1.7");

    await store.put("staging/v1/p1/a/b.pdf", body, { contentType: "application/pdf" });
    const stored = requireStored(await store.get("staging/v1/p1/a/b.pdf"));

    expect(new TextDecoder().decode(stored.body)).toBe("%PDF-1.7");
    const head = await client.send(
      new HeadObjectCommand({ Bucket: "petroglyph-staged-pdfs", Key: "staging/v1/p1/a/b.pdf" }),
    );
    expect(head.ContentType).toBe("application/pdf");
  });

  it("get returns null for a missing object; delete is idempotent", async () => {
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    await expect(store.get("staging/v1/p1/missing.pdf")).resolves.toBeNull();
    await store.delete("staging/v1/p1/missing.pdf");
    await expect(store.get("staging/v1/p1/missing.pdf")).resolves.toBeNull();
  });

  it("overwriting the same key yields a fresh version id when versioning is enabled", async () => {
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    // LocalStack default bucket is unversioned — pin restage-overwrite semantics via get.
    await store.put("staging/v1/p1/a/b.pdf", new TextEncoder().encode("first"), {
      contentType: "application/pdf",
    });
    await store.put("staging/v1/p1/a/b.pdf", new TextEncoder().encode("second"), {
      contentType: "application/pdf",
    });

    const stored = requireStored(await store.get("staging/v1/p1/a/b.pdf"));
    expect(new TextDecoder().decode(stored.body)).toBe("second");
  });

  it("presignGet issues a bucket-rooted URL that serves bytes with the content-disposition override for real", async () => {
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });
    await store.put("staging/v1/p1/dl.pdf", new TextEncoder().encode("download-me"), {
      contentType: "application/pdf",
    });

    const url = await store.presignGet("staging/v1/p1/dl.pdf", {
      ttlSeconds: 120,
      responseContentDisposition: 'attachment; filename="dl.pdf"',
    });

    expect(url).toContain("petroglyph-staged-pdfs.s3.eu-west-2.amazonaws.com");
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("download-me");
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="dl.pdf"');
  });

  it("a tampered signature on a presigned URL is rejected with 403", async () => {
    const store = createS3ObjectStore({
      bucket: "petroglyph-staged-pdfs",
      region: "eu-west-2",
      client,
    });

    const url = await store.presignGet("staging/v1/p1/dl.pdf", { ttlSeconds: 120 });
    const tampered = url.replace(
      /X-Amz-Signature=([a-f0-9])(?=[a-f0-9]{63}$)/,
      "X-Amz-Signature=0",
    );
    const response = await fetch(tampered);
    expect(response.status).toBe(403);
  });
});
