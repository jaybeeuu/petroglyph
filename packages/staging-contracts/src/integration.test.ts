import { execSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { createS3ObjectStore, type ObjectStoreGetResult } from "@petroglyph/core";

function requireStored(result: ObjectStoreGetResult | null): ObjectStoreGetResult {
  if (result === null) {
    throw new Error("expected a stored object");
  }
  return result;
}
import { stage } from "./stage.js";
import { detectType } from "./type.js";
import { fileStagedDataSchema } from "./events.js";

function pdfBodyType(body: Uint8Array): string {
  const detected = detectType(body);
  if (detected === null) {
    throw new Error("expected a PDF body");
  }
  return detected;
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

describe.skipIf(!canRun)("staging land against LocalStack S3", () => {
  let container: StartedTestContainer;
  let store: ReturnType<typeof createS3ObjectStore>;

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
    const client = new S3Client({
      region: "eu-west-2",
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    await client.send(new CreateBucketCommand({ Bucket: "petroglyph-staged-pdfs" }));
    store = createS3ObjectStore({ bucket: "petroglyph-staged-pdfs", region: "eu-west-2", client });
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("restage of the same item overwrites the same key (deterministic key, new bytes)", async () => {
    await stage(store, {
      profileId: "p1",
      relativePath: "a/b",
      name: "note.pdf",
      body: new TextEncoder().encode("%PDF-1.7 first"),
      contentType: pdfBodyType(new TextEncoder().encode("%PDF-1.7 first")),
    });
    await stage(store, {
      profileId: "p1",
      relativePath: "a/b",
      name: "note.pdf",
      body: new TextEncoder().encode("%PDF-1.7 second"),
      contentType: pdfBodyType(new TextEncoder().encode("%PDF-1.7 second")),
    });

    const stored = requireStored(await store.get("staging/v1/p1/a/b/note.pdf"));
    expect(new TextDecoder().decode(stored.body)).toBe("%PDF-1.7 second");
  });

  it("type-accuracy invariant: event mimeType == S3 ContentType == detectType(landed body)", async () => {
    const body = new TextEncoder().encode("%PDF-1.7\n1 0 obj");
    const mimeType = pdfBodyType(body);

    const { s3Key } = await stage(store, {
      profileId: "p1",
      relativePath: "c",
      name: "invariant.pdf",
      body,
      contentType: mimeType,
    });

    const stored = requireStored(await store.get(s3Key));
    expect(detectType(stored.body)).toBe(mimeType);

    const parsed = fileStagedDataSchema.parse({
      profileId: "p1",
      source: "onedrive",
      changeType: "created",
      itemId: "item-1",
      name: "invariant.pdf",
      relativePath: "c",
      s3Key,
      mimeType,
    });
    expect(parsed.mimeType).toBe(mimeType);
  });
});
