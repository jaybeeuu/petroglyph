import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockDbSend = vi.hoisted(() => vi.fn());

vi.mock("./db.js", () => ({
  docClient: { send: mockDbSend },
}));

import { app } from "./app.js";
import { resetKeyCache } from "./jwt.js";

describe("GET /sync/jobs/:jobId", () => {
  let privateKey: CryptoKey;
  let publicKeyPem: string;

  beforeAll(async () => {
    const keyPair = await generateKeyPair("RS256");
    privateKey = keyPair.privateKey as CryptoKey;
    publicKeyPem = await exportSPKI(keyPair.publicKey);
  });

  beforeEach(() => {
    vi.stubEnv("JWT_PUBLIC_KEY", publicKeyPem);
    vi.stubEnv("SYNC_JOBS_TABLE", "petroglyph-sync-jobs-test");
    mockDbSend.mockReset();
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

  async function getSyncJob(jobId: string, userId = "user-42"): Promise<Response> {
    const token = await makeToken(userId);
    return app.request(`/sync/jobs/${jobId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  }

  it("returns fileCount for a completed job", async () => {
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        return Promise.resolve({
          Item: {
            jobId: "job-123",
            userId: "user-42",
            status: "completed",
            fileCount: 7,
          },
        });
      }
      return Promise.resolve({});
    });

    const response = await getSyncJob("job-123");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; fileCount?: number; error?: string };
    expect(body).toEqual({ status: "completed", fileCount: 7 });
  });

  it("returns error for a failed job", async () => {
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        return Promise.resolve({
          Item: {
            jobId: "job-456",
            userId: "user-42",
            status: "failed",
            errorMessage: "Graph delta walk failed",
          },
        });
      }
      return Promise.resolve({});
    });

    const response = await getSyncJob("job-456");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; fileCount?: number; error?: string };
    expect(body).toEqual({ status: "failed", error: "Graph delta walk failed" });
  });

  it("returns the status for a queued job without fileCount or error", async () => {
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        return Promise.resolve({
          Item: {
            jobId: "job-789",
            userId: "user-42",
            status: "queued",
          },
        });
      }
      return Promise.resolve({});
    });

    const response = await getSyncJob("job-789");

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; fileCount?: number; error?: string };
    expect(body).toEqual({ status: "queued" });
  });

  it("returns 404 for an unknown jobId", async () => {
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        return Promise.resolve({ Item: undefined });
      }
      return Promise.resolve({});
    });

    const response = await getSyncJob("job-does-not-exist");

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Sync job not found");
  });

  it("returns 404 for another user's job and does not leak its details", async () => {
    mockDbSend.mockImplementation((command: unknown) => {
      if (command instanceof GetCommand) {
        return Promise.resolve({
          Item: {
            jobId: "job-777",
            userId: "user-99",
            status: "completed",
            fileCount: 42,
          },
        });
      }
      return Promise.resolve({});
    });

    const response = await getSyncJob("job-777");

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("Sync job not found");
  });

  it("returns 401 without a valid token", async () => {
    const response = await app.request("/sync/jobs/job-123", { method: "GET" });

    expect(response.status).toBe(401);
  });
});
