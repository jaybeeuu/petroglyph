import { beforeEach, describe, expect, it, vi } from "vitest";

const ssmSend = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-ssm", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual as object, {
    SSMClient: class {
      send = ssmSend;
    },
  });
});

vi.mock("@aws-sdk/lib-dynamodb", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.assign({}, actual as object, {
    DynamoDBDocumentClient: {
      from: () => ({
        send: vi.fn().mockResolvedValue({ Items: [] }),
      }),
    },
  });
});

import { buildDeltaRunner } from "./lambda.js";

describe("buildDeltaRunner parameter reads", () => {
  beforeEach(() => {
    ssmSend.mockReset();
    ssmSend.mockResolvedValue({ Parameter: { Value: "value" } });
    process.env["ONEDRIVE_CLIENT_ID_SSM_PATH"] = "/petroglyph/qa/onedrive/client-id";
    process.env["ONEDRIVE_CLIENT_SECRET_SSM_PATH"] = "/petroglyph/qa/onedrive/client-secret";
    process.env["REFRESH_TOKENS_TABLE"] = "petroglyph-token-vaults-qa";
    process.env["SYNC_PROFILES_TABLE"] = "petroglyph-sync-profiles-qa";
    process.env["STAGED_PDFS_BUCKET"] = "petroglyph-staged-pdfs-qa";
    process.env["EVENT_LOG_TABLE"] = "petroglyph-event-log-qa";
  });

  it("decrypts the OneDrive client credentials, which are SecureStrings", async () => {
    const run = buildDeltaRunner();

    await run({ userId: "user", provider: "onedrive" }).catch(() => undefined);

    const inputs = ssmSend.mock.calls.map((call) => (call[0] as { input: unknown }).input);

    expect(inputs).toStrictEqual(
      expect.arrayContaining([
        { Name: "/petroglyph/qa/onedrive/client-id", WithDecryption: true },
        { Name: "/petroglyph/qa/onedrive/client-secret", WithDecryption: true },
      ]),
    );
  });
});
