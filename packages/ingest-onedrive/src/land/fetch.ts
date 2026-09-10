import type { GraphClient } from "../tokens/graph-client.js";

export const CONTENT_PATH_PREFIX = "/me/drive/items/";

export function buildContentPath(itemId: string): string {
  return `${CONTENT_PATH_PREFIX}${encodeURIComponent(itemId)}/content`;
}

export type FetchOutcome = { kind: "fetched"; bytes: Uint8Array } | { kind: "not-found" };

/**
 * Downloads the item content through the graph client (Bearer + 401-retry
 * handled by the client). The wrapper never parses the body — the /content
 * bytes are opaque. 404 = the item vanished; the walk re-evaluates next time.
 */
export async function fetchItemContent(client: GraphClient, itemId: string): Promise<FetchOutcome> {
  const response = await client.request(buildContentPath(itemId));
  if (response.status === 404) {
    return { kind: "not-found" };
  }
  if (!response.ok) {
    throw new Error(`Content fetch for ${itemId} failed with status ${response.status}`);
  }
  return { kind: "fetched", bytes: new Uint8Array(await response.arrayBuffer()) };
}
