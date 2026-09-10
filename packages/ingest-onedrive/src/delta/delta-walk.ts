import { z } from "zod";
import type { GraphClient } from "../tokens/graph-client.js";
import type { DeltaStateStore } from "./delta-state-store.js";

const driveItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  changeType: z.enum(["created", "updated", "deleted"]).optional(),
  parentReference: z.object({ path: z.string() }).optional(),
  file: z.object({ mimeType: z.string().min(1) }).optional(),
  folder: z.record(z.string(), z.unknown()).optional(),
  deleted: z.record(z.string(), z.unknown()).optional(),
});

const deltaPageSchema = z.object({
  value: z.array(driveItemSchema),
  "@odata.nextLink": z.string().min(1).optional(),
  "@odata.deltaLink": z.string().min(1).optional(),
});

type DriveItem = z.infer<typeof driveItemSchema>;

/** Adapter-internal change fact (6.5.2.1 contract). Never registered. */
export interface FileChangeEvent {
  profileId: string;
  changeType: "created" | "updated" | "deleted";
  itemId: string;
  name: string;
  /** NORMALIZED here — the OneDrive parentReference.path format never leaks. */
  relativePath: string;
  /** Pre-download filter input only; never persisted, never in the event. */
  mimeType?: string;
  isFolder: boolean;
}

export type DeltaWalkOutcome = "continued" | "reset" | "failed";

export interface DeltaWalkResult {
  events: FileChangeEvent[];
  deltaLink?: string;
  outcome: DeltaWalkOutcome;
}

export interface DeltaWalkProfile {
  profileId: string;
  /** Profile source-dir prefix; items outside every profile's prefix are dropped. */
  rootPath?: string;
}

export interface DeltaWalkOptions {
  client: GraphClient;
  store: DeltaStateStore;
  connection: { userId: string; provider: string };
  profiles: DeltaWalkProfile[];
  /** First-call (no token) full-enumeration URL. */
  initialUrl: string;
}

/** Strips up to the drive root: "/drive/root:/notes/sub" → "notes/sub". */
export function normalizeRelativePath(parentPath: string): string {
  const match = parentPath.match(/^(?:\/drive\/root|\/drives\/[^/]+\/root):?\/(.*)$/);
  if (match === null) {
    return "";
  }
  const remainder = (match[1] ?? "").replace(/\/+$/, "");
  return remainder;
}

function isResetResponse(status: number, body: unknown): boolean {
  if (status === 410) {
    return true;
  }
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return code === "syncStateNotFound";
}

/**
 * Delta walk + change-token management. Full enumeration when no token is
 * stored; pages @odata.nextLink until the terminal @odata.deltaLink; writes
 * the state ONLY on successful completion; 410/syncStateNotFound clears the
 * token and re-enumerates from scratch (outcome reset).
 */
export async function walkDelta(options: DeltaWalkOptions): Promise<DeltaWalkResult> {
  const stored = await options.store.read(options.connection.userId, options.connection.provider);
  const events: FileChangeEvent[] = [];

  let outcome: DeltaWalkOutcome = "continued";
  let response = await options.client.request(stored?.deltaLink ?? options.initialUrl);
  let body: unknown = await response.json().catch(() => null);

  if (isResetResponse(response.status, body)) {
    await options.store.clear(options.connection.userId, options.connection.provider);
    response = await options.client.request(options.initialUrl);
    body = await response.json().catch(() => null);
    outcome = "reset";
    if (isResetResponse(response.status, body)) {
      return { events, outcome: "failed" };
    }
  }

  let terminalDeltaLink: string | undefined;

  while (true) {
    if (response.status !== 200) {
      return { events, outcome: "failed" };
    }
    const parsed = deltaPageSchema.safeParse(body);
    if (!parsed.success) {
      return { events, outcome: "failed" };
    }

    events.push(...classifyPage(parsed.data.value, options.profiles));

    const deltaLink = parsed.data["@odata.deltaLink"];
    if (deltaLink !== undefined) {
      terminalDeltaLink = deltaLink;
      break;
    }

    const nextLink = parsed.data["@odata.nextLink"];
    if (nextLink === undefined) {
      break;
    }

    const next = await options.client.request(nextLink);
    const nextBody: unknown = await next.json().catch(() => null);
    if (isResetResponse(next.status, nextBody)) {
      // Token expired mid-walk — clear and full resync.
      await options.store.clear(options.connection.userId, options.connection.provider);
      response = await options.client.request(options.initialUrl);
      body = await response.json().catch(() => null);
      outcome = "reset";
      if (isResetResponse(response.status, body)) {
        return { events, outcome: "failed" };
      }
      continue;
    }
    response = next;
    body = nextBody;
  }

  if (terminalDeltaLink !== undefined) {
    await options.store.write(options.connection.userId, options.connection.provider, {
      deltaLink: terminalDeltaLink,
      updatedAt: new Date().toISOString(),
    });
  }

  return {
    events,
    ...(terminalDeltaLink === undefined ? {} : { deltaLink: terminalDeltaLink }),
    outcome,
  };
}

function classifyPage(items: DriveItem[], profiles: DeltaWalkProfile[]): FileChangeEvent[] {
  const events: FileChangeEvent[] = [];
  for (const item of items) {
    if (item.deleted !== undefined) {
      const event = classifyDeleted(item, profiles);
      if (event !== null) {
        events.push(event);
      }
      continue;
    }
    if (item.file === undefined) {
      continue; // created/updated folders are classified but never fetched
    }
    const event = classifyFile(item, profiles);
    if (event !== null) {
      events.push(event);
    }
  }
  return events;
}

function routeToProfile(
  profiles: DeltaWalkProfile[],
  relativePath: string,
): DeltaWalkProfile | undefined {
  return profiles.find(
    (profile) =>
      profile.rootPath === undefined ||
      relativePath === profile.rootPath ||
      relativePath.startsWith(`${profile.rootPath}/`),
  );
}

function classifyFile(item: DriveItem, profiles: DeltaWalkProfile[]): FileChangeEvent | null {
  const relativePath = normalizeRelativePath(item.parentReference?.path ?? "");
  const profile = routeToProfile(profiles, relativePath);
  if (profile === undefined) {
    return null;
  }
  return {
    profileId: profile.profileId,
    changeType: item.changeType === "updated" ? "updated" : "created",
    itemId: item.id,
    name: item.name ?? item.id,
    relativePath,
    ...(item.file === undefined ? {} : { mimeType: item.file.mimeType }),
    isFolder: false,
  };
}

function classifyDeleted(item: DriveItem, profiles: DeltaWalkProfile[]): FileChangeEvent | null {
  const relativePath = normalizeRelativePath(item.parentReference?.path ?? "");
  const profile = routeToProfile(profiles, relativePath);
  if (profile === undefined) {
    return null;
  }
  return {
    profileId: profile.profileId,
    changeType: "deleted",
    itemId: item.id,
    name: item.name ?? item.id,
    relativePath,
    isFolder: item.folder !== undefined,
  };
}
