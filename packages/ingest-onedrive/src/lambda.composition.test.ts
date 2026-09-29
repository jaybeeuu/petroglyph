import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { SyncProfile } from "@petroglyph/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSsmSend = vi.hoisted(() => vi.fn());
const mockDocSend = vi.hoisted(() => vi.fn());
const mockS3Send = vi.hoisted(() => vi.fn());
const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-ssm", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual as object, {
    SSMClient: class {
      send = mockSsmSend;
    },
  });
});

vi.mock("@aws-sdk/lib-dynamodb", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual as object, {
    DynamoDBDocumentClient: {
      from: () => ({ send: mockDocSend }),
    },
  });
});

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual as object, {
    S3Client: class {
      send = mockS3Send;
    },
  });
});

vi.stubGlobal("fetch", mockFetch);

import { buildDeltaRunner } from "./lambda.js";

/**
 * The real adapter shell reads every table from the environment; these are the
 * staging values, never the legacy defaults the bead deletes. The staged bucket
 * is the fourth required name.
 */
const TABLES = {
  refreshTokens: "petroglyph-refresh-tokens-staging",
  syncProfiles: "petroglyph-sync-profiles-staging",
  eventLog: "petroglyph-event-log-staging",
  deltaTokens: "petroglyph-delta-tokens-staging",
};

const STAGED_BUCKET = "petroglyph-staged-pdfs-staging";
const CONNECTION = { userId: "user-1", provider: "onedrive" };
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj");

interface DynamoCommand {
  input: { TableName?: string };
}

function makeTokenRecord(): {
  accessToken: string;
  refreshToken: string;
  expirySeconds: number;
  updatedAt: string;
  reconnectRequired: boolean;
} {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expirySeconds: Math.floor(Date.now() / 1000) + 3600,
    updatedAt: "2026-09-29T00:00:00.000Z",
    reconnectRequired: false,
  };
}

function makeProfile(overrides: Partial<SyncProfile> = {}): SyncProfile {
  return {
    profileId: "profile-notes",
    userId: CONNECTION.userId,
    name: "Notes",
    sourceFolderPath: "notes",
    destinationVaultPath: "notes",
    pollingIntervalMinutes: 5,
    enabled: true,
    active: true,
    initialSyncEnabled: true,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
    ...overrides,
  };
}

function fileItem(id: string, folder: string): { [key: string]: unknown } {
  return {
    id,
    name: `${id}.pdf`,
    eTag: `etag-${id}`,
    parentReference: { path: `/drive/root:/${folder}` },
    file: { mimeType: "application/pdf" },
  };
}

function deltaResponse(items: { [key: string]: unknown }[]): Response {
  return new Response(
    JSON.stringify({
      value: items,
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/drive/root/delta?token=next",
    }),
    { status: 200 },
  );
}

function wireDynamo(profiles: SyncProfile[] = []): void {
  mockDocSend.mockImplementation((command: unknown) => {
    if (command instanceof QueryCommand) {
      return Promise.resolve({ Items: profiles });
    }
    if (command instanceof GetCommand) {
      return Promise.resolve(
        command.input.TableName === TABLES.refreshTokens ? { Item: makeTokenRecord() } : {},
      );
    }
    if (command instanceof PutCommand || command instanceof UpdateCommand) {
      return Promise.resolve({});
    }
    return Promise.resolve({});
  });
}

function wireGraph(items: { [key: string]: unknown }[]): void {
  mockFetch.mockImplementation((url: string) =>
    url.includes("/content")
      ? Promise.resolve(new Response(PDF_BYTES, { status: 200 }))
      : Promise.resolve(deltaResponse(items)),
  );
}

function sentTableNames(): (string | undefined)[] {
  return mockDocSend.mock.calls.map((call) => (call[0] as DynamoCommand).input.TableName);
}

function landedS3Keys(): string[] {
  return mockS3Send.mock.calls.map((call) => (call[0] as { input: { Key: string } }).input.Key);
}

function fetchedUrls(): string[] {
  return mockFetch.mock.calls.map((call) => call[0] as string);
}

describe("adapter lambda composition (buildDeltaRunner)", () => {
  beforeEach(() => {
    mockSsmSend.mockReset().mockResolvedValue({ Parameter: { Value: "ssm-parameter-value" } });
    mockDocSend.mockReset();
    mockS3Send.mockReset().mockResolvedValue({});
    mockFetch.mockReset();
    vi.stubEnv("REFRESH_TOKENS_TABLE", TABLES.refreshTokens);
    vi.stubEnv("SYNC_PROFILES_TABLE", TABLES.syncProfiles);
    vi.stubEnv("EVENT_LOG_TABLE", TABLES.eventLog);
    vi.stubEnv("DELTA_TOKENS_TABLE", TABLES.deltaTokens);
    vi.stubEnv("STAGED_PDFS_BUCKET", STAGED_BUCKET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads every table name from the environment and uses the built-in graph defaults", async () => {
    wireDynamo([makeProfile()]);
    wireGraph([fileItem("file-1", "notes")]);

    const result = await buildDeltaRunner()(CONNECTION);

    expect(result).toMatchObject({ outcome: "completed", landed: 1 });
    expect(sentTableNames()).toEqual(
      expect.arrayContaining([
        TABLES.refreshTokens,
        TABLES.syncProfiles,
        TABLES.eventLog,
        TABLES.deltaTokens,
      ]),
    );
    const urls = fetchedUrls();
    expect(urls).toContain("https://graph.microsoft.com/v1.0/me/drive/items/file-1/content");
    expect(
      urls.some((url) => url.startsWith("https://graph.microsoft.com/v1.0/me/drive/root/delta")),
    ).toBe(true);
  });

  it("walks only profiles that are both enabled and active", async () => {
    wireDynamo([
      makeProfile({
        profileId: "profile-notes",
        sourceFolderPath: "notes",
        enabled: true,
        active: true,
      }),
      makeProfile({
        profileId: "profile-disabled",
        sourceFolderPath: "disabled",
        enabled: false,
        active: true,
      }),
      makeProfile({
        profileId: "profile-inactive",
        sourceFolderPath: "inactive",
        enabled: true,
        active: false,
      }),
    ]);
    wireGraph([
      fileItem("file-notes", "notes"),
      fileItem("file-disabled", "disabled"),
      fileItem("file-inactive", "inactive"),
    ]);

    const result = await buildDeltaRunner()(CONNECTION);

    expect(result).toMatchObject({ outcome: "completed", landed: 1 });
    expect(landedS3Keys()).toEqual(["staging/v1/profile-notes/notes/file-notes.pdf"]);
  });

  it.each([
    ["REFRESH_TOKENS_TABLE"],
    ["SYNC_PROFILES_TABLE"],
    ["EVENT_LOG_TABLE"],
    ["DELTA_TOKENS_TABLE"],
    ["STAGED_PDFS_BUCKET"],
  ])("throws naming %s when the variable is unset", async (name) => {
    vi.stubEnv(name, "");
    wireDynamo();
    wireGraph([]);

    await expect(buildDeltaRunner()(CONNECTION)).rejects.toThrow(name);
  });
});
