import { describe, expect, it } from "vitest";
import type { SmokeAws } from "./aws.js";
import { readSmokeConfig } from "./config.js";
import { SMOKE_ITEM_ID, SMOKE_PROFILE_ID, SMOKE_USER_ID } from "./fixtures.js";
import { runSmoke, type RunSmokeDeps } from "./smoke.js";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\n(petroglyph smoke)\n%%EOF");
const PRESIGNED_URL = "https://s3.example.test/signed";

interface RecordedRequest {
  url: string;
  authorization: string | null;
}

interface RecordedDelete {
  table: string;
  key: { [key: string]: unknown };
}

function createStagedRecord(): { [key: string]: unknown } {
  return {
    profileId: SMOKE_PROFILE_ID,
    itemId: SMOKE_ITEM_ID,
    name: "smoke.pdf",
    mimeType: "application/pdf",
    relativePath: "notes",
    s3Key: "staging/v1/smoke-profile/notes/smoke.pdf",
  };
}

function createRunDeps(
  options: {
    stagedRecord?: { [key: string]: unknown } | null;
    download?: Uint8Array;
  } = {},
): {
  deps: RunSmokeDeps;
  deleted: RecordedDelete[];
  put: { table: string; item: { [key: string]: unknown } }[];
  messages: string[];
  requests: RecordedRequest[];
} {
  const config = readSmokeConfig({
    SMOKE_API_BASE_URL: "https://api.example.test",
    SMOKE_DELTA_TRIGGER_QUEUE_URL: "https://sqs.eu-west-2.amazonaws.com/123/delta-trigger.fifo",
    SMOKE_STAGED_RECORDS_TABLE: "staged-records",
    SMOKE_SYNC_PROFILES_TABLE: "sync-profiles",
    SMOKE_TOKEN_VAULTS_TABLE: "token-vaults",
    SMOKE_DELTA_STATES_TABLE: "delta-states",
    SMOKE_JWT_PRIVATE_KEY_SSM_PATH: "/petroglyph/qa/jwt/private-key",
    AWS_REGION: "eu-west-2",
  });

  const stagedRecord =
    options.stagedRecord === undefined ? createStagedRecord() : options.stagedRecord;
  const deleted: RecordedDelete[] = [];
  const put: { table: string; item: { [key: string]: unknown } }[] = [];
  const messages: string[] = [];
  const requests: RecordedRequest[] = [];

  const fetchFn: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/files")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            files: [
              {
                itemId: SMOKE_ITEM_ID,
                name: "smoke.pdf",
                relativePath: "notes",
                mimeType: "application/pdf",
                s3PresignedUrl: PRESIGNED_URL,
                createdAt: "2026-10-12T00:00:00.000Z",
              },
            ],
            nextToken: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (url === PRESIGNED_URL) {
      return Promise.resolve(new Response(options.download ?? PDF_BYTES, { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  const aws: SmokeAws = {
    deleteItem: (table, key) => {
      deleted.push({ table, key });
      return Promise.resolve();
    },
    putItem: (table, item) => {
      put.push({ table, item });
      return Promise.resolve();
    },
    getItem: () => Promise.resolve(stagedRecord),
    sendMessage: (_queueUrl, body) => {
      messages.push(body);
      return Promise.resolve();
    },
    getParameter: () => Promise.resolve("pem"),
  };

  return {
    deps: {
      config,
      aws,
      fetchFn,
      clock: {
        now: () => 0,
        sleep: () => {
          throw new Error("the journey should not wait when the record is present");
        },
      },
      mintJwt: () => Promise.resolve("smoke-jwt"),
      log: () => undefined,
    },
    deleted,
    put,
    messages,
    requests,
  };
}

describe("runSmoke", () => {
  it("resets, seeds, triggers, reads /files with the smoke identity and downloads the PDF", async () => {
    const { deps, deleted, put, messages, requests } = createRunDeps();

    await runSmoke(deps);

    expect(deleted).toContainEqual({
      table: "staged-records",
      key: { profileId: SMOKE_PROFILE_ID, itemId: SMOKE_ITEM_ID },
    });
    expect(messages).toEqual([JSON.stringify({ userId: SMOKE_USER_ID, provider: "onedrive" })]);
    const tokenVaultPut = put.find((entry) => entry.table === "token-vaults");
    expect(tokenVaultPut?.item).toMatchObject({ userId: SMOKE_USER_ID, provider: "onedrive" });
    expect(requests.find((request) => request.url.endsWith("/files"))?.authorization).toBe(
      "Bearer smoke-jwt",
    );
    expect(requests.some((request) => request.url === PRESIGNED_URL)).toBe(true);
  });

  it("fails when the staged record never appears", async () => {
    const { deps } = createRunDeps({ stagedRecord: null });

    await expect(
      runSmoke({
        ...deps,
        clock: {
          now: () => Date.now(),
          sleep: async (milliseconds: number) =>
            new Promise((resolve) => {
              setTimeout(resolve, milliseconds);
            }),
        },
        config: { ...deps.config, timeoutSeconds: 1, pollIntervalMs: 10 },
      }),
    ).rejects.toThrow(/timed out/);
  });

  it("fails when the downloaded object is not a PDF", async () => {
    const { deps } = createRunDeps({ download: new TextEncoder().encode("not a pdf") });

    await expect(runSmoke(deps)).rejects.toThrow(/not a PDF/);
  });
});
