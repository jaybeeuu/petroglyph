import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type ServiceOutputTypes,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface StagedObjectStorePutResult {
  versionId?: string;
}

export interface StagedObjectStoreGetResult {
  body: Uint8Array;
  etag?: string;
}

export interface StagedObjectStorePresignGetOptions {
  ttlSeconds?: number;
  responseContentDisposition?: string;
}

/**
 * Keys and bytes, no domain knowledge. The staging domain's layout lives beside
 * this port in deriveStagingKey; presigned URLs are an S3 concern and are
 * issued from stored keys here — readers never derive keys.
 */
export interface StagedObjectStore {
  put(
    key: string,
    body: Uint8Array,
    options: { contentType?: string },
  ): Promise<StagedObjectStorePutResult>;
  /** null signals absent — callers must never receive a throw for a missing object. */
  get(key: string): Promise<StagedObjectStoreGetResult | null>;
  /** Idempotent: deleting a missing object is a no-op. */
  delete(key: string): Promise<void>;
  presignGet(key: string, options?: StagedObjectStorePresignGetOptions): Promise<string>;
}

function isNotFoundError(error: unknown): boolean {
  const name = (error as { name?: unknown }).name;
  return (
    name === "NotFound" ||
    (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode === 404
  );
}

export function createS3StagedObjectStore(options: {
  bucket: string;
  region: string;
  client?: S3Client;
}): StagedObjectStore {
  const client: S3Client = options.client ?? new S3Client({ region: options.region });
  const bucket = options.bucket;

  return {
    async put(key, body, putOptions) {
      const output = (await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ...(putOptions.contentType === undefined ? {} : { ContentType: putOptions.contentType }),
        }),
      )) as ServiceOutputTypes;
      const versionId = (output as { VersionId?: string }).VersionId;
      return versionId === undefined ? {} : { versionId };
    },

    async get(key) {
      try {
        const output = await client.send(
          new GetObjectCommand({
            Bucket: bucket,
            Key: key,
          }),
        );
        const streamedBody = output.Body;
        if (streamedBody === undefined) {
          throw new Error(`Object ${key} returned no body`);
        }
        return {
          body: new Uint8Array(await streamedBody.transformToByteArray()),
          ...(output.ETag === undefined ? {} : { etag: output.ETag }),
        };
      } catch (error) {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },

    async delete(key) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
        }),
      );
    },

    async presignGet(key, presignOptions) {
      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(presignOptions?.responseContentDisposition === undefined
          ? {}
          : { ResponseContentDisposition: presignOptions.responseContentDisposition }),
      });
      return getSignedUrl(client, command, {
        expiresIn: presignOptions?.ttlSeconds ?? 3600,
      });
    },
  };
}
