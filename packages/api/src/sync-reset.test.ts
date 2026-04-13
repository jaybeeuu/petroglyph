import { DeleteParameterCommand } from "@aws-sdk/client-ssm";
import { BatchWriteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());
const mockSsmSend = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

vi.mock("./ssm.js", () => ({
  ssmClient: { send: mockSsmSend },
}));

import { app } from "./app.js";
import { resetKeyCache } from "./jwt.js";

describe("POST /sync/reset", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.stubEnv("FILE_RECORDS_TABLE", "petroglyph-file-records-test");
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    mockDbSend.mockReset();
    mockSsmSend.mockReset();
    resetKeyCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetKeyCache();
  });

  async function makeToken(userId = "user-42", username = "octocat"): Promise<string> {
    return new SignJWT({ username })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(userId)
      .setIssuer("petroglyph-api")
      .setAudience("petroglyph-plugin")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
  }

  async function postReset(scope: unknown): Promise<Response> {
    const token = await makeToken();

    return app.request("/sync/reset", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scope }),
    });
  }

  it("returns 400 for an invalid scope", async () => {
    const response = await postReset("plugin");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid reset scope",
    });
  });

  it("deletes the delta token and file records for a server reset", async () => {
    const batchWriteResponses = [
      {
        UnprocessedItems: {
          "petroglyph-file-records-test": [
            {
              DeleteRequest: {
                Key: { profileId: "default", fileId: "file-2" },
              },
            },
          ],
        },
      },
      {},
    ];

    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof QueryCommand) {
        return Promise.resolve({
          Items: [
            { profileId: "default", fileId: "file-1" },
            { profileId: "default", fileId: "file-2" },
          ],
        });
      }

      if (command instanceof BatchWriteCommand) {
        return Promise.resolve(batchWriteResponses.shift() ?? {});
      }

      return Promise.resolve({});
    });
    mockSsmSend.mockResolvedValue({});

    const response = await postReset("server");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resetToken: false });

    const deleteParameterCalls = mockSsmSend.mock.calls.filter(
      ([command]) => command instanceof DeleteParameterCommand,
    );
    expect(deleteParameterCalls).toHaveLength(1);

    const [deleteParameterCommand] = deleteParameterCalls[0] as [{ input: { Name: string } }];
    expect(deleteParameterCommand.input.Name).toBe("/petroglyph/onedrive/delta-token");

    const queryCalls = mockDbSend.mock.calls.filter(([command]) => command instanceof QueryCommand);
    expect(queryCalls).toHaveLength(1);

    const [queryCommand] = queryCalls[0] as [
      { input: { TableName: string; ExpressionAttributeValues: { ":profileId": string } } },
    ];
    expect(queryCommand.input.TableName).toBe("petroglyph-file-records-test");
    expect(queryCommand.input.ExpressionAttributeValues[":profileId"]).toBe("default");

    const batchWriteCalls = mockDbSend.mock.calls.filter(
      ([command]) => command instanceof BatchWriteCommand,
    );
    expect(batchWriteCalls).toHaveLength(2);

    const [firstBatchWriteCommand] = batchWriteCalls[0] as [
      {
        input: {
          RequestItems: {
            [tableName: string]: Array<{
              DeleteRequest: { Key: { profileId: string; fileId: string } };
            }>;
          };
        };
      },
    ];
    expect(firstBatchWriteCommand.input.RequestItems["petroglyph-file-records-test"]).toEqual([
      { DeleteRequest: { Key: { profileId: "default", fileId: "file-1" } } },
      { DeleteRequest: { Key: { profileId: "default", fileId: "file-2" } } },
    ]);

    const [secondBatchWriteCommand] = batchWriteCalls[1] as [
      {
        input: {
          RequestItems: {
            [tableName: string]: Array<{
              DeleteRequest: { Key: { profileId: string; fileId: string } };
            }>;
          };
        };
      },
    ];
    expect(secondBatchWriteCommand.input.RequestItems["petroglyph-file-records-test"]).toEqual([
      { DeleteRequest: { Key: { profileId: "default", fileId: "file-2" } } },
    ]);
  });

  it("returns resetToken=true for a full reset after clearing server state", async () => {
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof QueryCommand) {
        return Promise.resolve({
          Items: [{ profileId: "default", fileId: "file-9" }],
        });
      }

      if (command instanceof BatchWriteCommand) {
        return Promise.resolve({});
      }

      return Promise.resolve({});
    });
    mockSsmSend.mockResolvedValue({});

    const response = await postReset("full");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resetToken: true });

    expect(
      mockSsmSend.mock.calls.some(([command]) => command instanceof DeleteParameterCommand),
    ).toBe(true);
    expect(mockDbSend.mock.calls.some(([command]) => command instanceof QueryCommand)).toBe(true);
    expect(mockDbSend.mock.calls.some(([command]) => command instanceof BatchWriteCommand)).toBe(
      true,
    );
  });
});
