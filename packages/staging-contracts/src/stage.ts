import type { ObjectStore } from "@petroglyph/core";
import { deriveStagingKey } from "./keys.js";

export interface StageInput {
  profileId: string;
  relativePath: string;
  name: string;
  body: Uint8Array;
  /**
   * REQUIRED — always from detectType(body) at land time, never defaulted
   * (a default would store a lie we can verify against the bytes).
   */
  contentType: string;
}

/**
 * derive + put ONLY. Fetching, gating and event emission are adapter-owned
 * glue (6.5.1.1) — this lib holds no Graph, no queue, no gate logic.
 */
export async function stage(
  store: ObjectStore,
  input: StageInput,
): Promise<{ s3Key: string; versionId?: string }> {
  const s3Key = deriveStagingKey({
    profileId: input.profileId,
    relativePath: input.relativePath,
    name: input.name,
  });
  const { versionId } = await store.put(s3Key, input.body, { contentType: input.contentType });
  return versionId === undefined ? { s3Key } : { s3Key, versionId };
}
