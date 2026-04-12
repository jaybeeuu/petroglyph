import { GetObjectCommand } from "@aws-sdk/client-s3";
import { GetParameterCommand } from "@aws-sdk/client-ssm";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());
const mockSsmSend = vi.hoisted(() => vi.fn());
const mockGetSignedUrl = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

vi.mock("./ssm.js", () => ({
  ssmClient: { send: mockSsmSend },
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

import { app } from "./app.js";
import { resetKeyCache } from "./jwt.js";

describe("GET /files/changes", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("FILE_RECORDS_TABLE", "petroglyph-file-records-test");
    vi.stubEnv("STAGED_PDFS_BUCKET", "petroglyph-staged-pdfs-test");
    mockDbSend.mockReset();
    mockSsmSend.mockReset();
    mockGetSignedUrl.mockReset();
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

  function encodeCursor(cursor: { profileId: string; fileId: string }): string {
    return Buffer.from(JSON.stringify(cursor)).toString("base64url");
  }

  async function getChanges(query = ""): Promise<Response> {
    const token = await makeToken();

    return app.request(`/files/changes${query}`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  }

  it("returns an empty page when initial sync is disabled and no cursor is provided", async () => {
    mockSsmSend.mockImplementation((command: unknown) => {
      if (command instanceof GetParameterCommand) {
        return Promise.resolve({
          Parameter: { Value: "false" },
        });
      }

      return Promise.reject(new Error("Unexpected SSM call"));
    });
    mockDbSend.mockImplementation(() => Promise.reject(new Error("Unexpected DB call")));

    const response = await getChanges();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      files: [],
      nextToken: null,
    });
    expect(mockDbSend).not.toHaveBeenCalled();
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it("returns the first page from the beginning when initial sync is enabled", async () => {
    mockSsmSend.mockImplementation((command: unknown) => {
      if (command instanceof GetParameterCommand) {
        return Promise.resolve({
          Parameter: { Value: "true" },
        });
      }

      return Promise.reject(new Error("Unexpected SSM call"));
    });
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof QueryCommand) {
        return Promise.resolve({
          Items: [
            {
              profileId: "default",
              fileId: "file-2",
              filename: "later.pdf",
              createdAt: "2024-01-02T12:00:00.000Z",
              s3Key: "staged/later.pdf",
              pageCount: 3,
            },
            {
              profileId: "default",
              fileId: "file-1",
              filename: "earlier.pdf",
              createdAt: "2024-01-01T12:00:00.000Z",
              s3Key: "staged/earlier.pdf",
            },
          ],
        });
      }

      return Promise.reject(new Error("Unexpected DB call"));
    });
    mockGetSignedUrl.mockImplementation(
      async (_client: unknown, command: unknown, options: { expiresIn: number }) => {
        expect(command).toBeInstanceOf(GetObjectCommand);
        const getObjectCommand = command as GetObjectCommand;
        return `signed:${getObjectCommand.input.Key}:${options.expiresIn}`;
      },
    );

    const response = await getChanges("?limit=25");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      files: [
        {
          fileId: "file-1",
          s3PresignedUrl: "signed:staged/earlier.pdf:900",
          filename: "earlier.pdf",
          createdAt: "2024-01-01T12:00:00.000Z",
        },
        {
          fileId: "file-2",
          s3PresignedUrl: "signed:staged/later.pdf:900",
          filename: "later.pdf",
          createdAt: "2024-01-02T12:00:00.000Z",
          pageCount: 3,
        },
      ],
      nextToken: null,
    });
  });

  it("uses the opaque cursor to continue from the next page", async () => {
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof QueryCommand) {
        return Promise.resolve({
          Items: [
            {
              profileId: "default",
              fileId: "file-3",
              filename: "page-two.pdf",
              createdAt: "2024-01-03T12:00:00.000Z",
              s3Key: "staged/page-two.pdf",
            },
          ],
          LastEvaluatedKey: {
            profileId: "default",
            fileId: "file-4",
          },
        });
      }

      return Promise.reject(new Error("Unexpected DB call"));
    });
    mockGetSignedUrl.mockImplementation(
      async (_client: unknown, command: unknown, options: { expiresIn: number }) => {
        expect(command).toBeInstanceOf(GetObjectCommand);
        const getObjectCommand = command as GetObjectCommand;
        return `signed:${getObjectCommand.input.Key}:${options.expiresIn}`;
      },
    );

    const after = encodeCursor({
      profileId: "default",
      fileId: "file-2",
    });

    const response = await getChanges(`?after=${after}&limit=1`);

    expect(response.status).toBe(200);
    expect(mockSsmSend).not.toHaveBeenCalled();

    const queryCalls = mockDbSend.mock.calls.filter(
      ([command]) => command instanceof QueryCommand,
    );
    expect(queryCalls).toHaveLength(1);

    const [queryCommand] = queryCalls[0] as [
      { input: { ExclusiveStartKey: { profileId: string; fileId: string } } },
    ];
    expect(queryCommand.input.ExclusiveStartKey).toEqual({
      profileId: "default",
      fileId: "file-2",
    });

    const body = (await response.json()) as {
      files: Array<{
        fileId: string;
        s3PresignedUrl: string;
        filename: string;
        createdAt: string;
      }>;
      nextToken: string | null;
    };
    expect(body.files).toEqual([
      {
        fileId: "file-3",
        s3PresignedUrl: "signed:staged/page-two.pdf:900",
        filename: "page-two.pdf",
        createdAt: "2024-01-03T12:00:00.000Z",
      },
    ]);
    expect(body.nextToken).toBe(encodeCursor({ profileId: "default", fileId: "file-4" }));
  });

  it("returns null nextToken on the last page", async () => {
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof QueryCommand) {
        return Promise.resolve({
          Items: [
            {
              profileId: "default",
              fileId: "file-5",
              filename: "final.pdf",
              createdAt: "2024-01-05T12:00:00.000Z",
              s3Key: "staged/final.pdf",
            },
          ],
        });
      }

      return Promise.reject(new Error("Unexpected DB call"));
    });
    mockGetSignedUrl.mockResolvedValue("signed:staged/final.pdf:900");

    const after = encodeCursor({
      profileId: "default",
      fileId: "file-4",
    });

    const response = await getChanges(`?after=${after}&limit=1`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      files: [
        {
          fileId: "file-5",
          s3PresignedUrl: "signed:staged/final.pdf:900",
          filename: "final.pdf",
          createdAt: "2024-01-05T12:00:00.000Z",
        },
      ],
      nextToken: null,
    });
  });

  it("returns 400 for an invalid limit", async () => {
    const response = await getChanges("?limit=0");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid files changes query",
    });
  });
});
