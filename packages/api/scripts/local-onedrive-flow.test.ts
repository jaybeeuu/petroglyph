import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseArgs, readLocalState, runLocalFlow, writeLocalState } from "./local-onedrive-flow.js";

describe("local-onedrive-flow helpers", () => {
  it("parses CLI arguments", () => {
    const args = parseArgs([
      "--api-base-url",
      "http://127.0.0.1:3000",
      "--state-path",
      "/tmp/petroglyph-flow.json",
      "--callback-port",
      "9001",
      "--no-open",
    ]);

    expect(args).toEqual({
      apiBaseUrl: "http://127.0.0.1:3000",
      statePath: "/tmp/petroglyph-flow.json",
      callbackPort: 9001,
      noOpen: true,
      logPath: expect.stringContaining("local-onedrive-flow.log") as string,
    });
  });

  it("round-trips local state to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petroglyph-flow-"));
    const statePath = join(dir, "state.json");

    try {
      expect(await readLocalState(statePath)).toEqual({});

      await writeLocalState(statePath, {
        github: {
          jwt: "jwt-1",
          refreshToken: "refresh-1",
          username: "alice",
        },
        oneDrive: {
          connected: true,
          lastStatus: "connected",
        },
      });

      const persisted = await readLocalState(statePath);
      expect(persisted.github?.username).toBe("alice");
      expect(persisted.oneDrive?.connected).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs the local auth and refresh flow", async () => {
    const dir = await mkdtemp(join(tmpdir(), "petroglyph-flow-"));
    const statePath = join(dir, "state.json");
    const openBrowser = vi.fn((): Promise<void> => Promise.resolve());
    const githubCallback = {
      jwt: "jwt-1",
      refreshToken: "refresh-1",
      username: "alice",
    };
    const oneDriveCallback = {
      code: "code-1",
      state: "state-1",
    };
    const waitForGithubCallback = vi.fn(() => Promise.resolve(githubCallback));
    const waitForOneDriveCallback = vi.fn(() => Promise.resolve(oneDriveCallback));

    const fetchFn = vi.fn(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

        if (url.startsWith("http://api.example.test/auth/url")) {
          return Promise.resolve(
            new Response(JSON.stringify({ url: "https://github.example.test/auth" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        if (url.startsWith("http://api.example.test/onedrive/auth-url")) {
          return Promise.resolve(
            new Response(JSON.stringify({ url: "https://login.microsoftonline.com/auth" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        if (url === "http://api.example.test/onedrive/connect" && init?.method === "POST") {
          return Promise.resolve(
            new Response(JSON.stringify({ status: "connected" }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          );
        }

        if (url === "http://api.example.test/status") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                github: { connected: true, username: "alice" },
                oneDrive: { connected: true },
                oneDriveStatus: "connected",
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }

        if (url === "http://api.example.test/auth/refresh" && init?.method === "POST") {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                jwt: "jwt-2",
                refreshToken: "refresh-2",
              }),
              {
                status: 200,
                headers: { "Content-Type": "application/json" },
              },
            ),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch: ${url}`));
      },
    );

    try {
      const state = await runLocalFlow({
        apiBaseUrl: "http://api.example.test",
        statePath,
        callbackPort: 8787,
        openBrowser,
        fetchFn,
        log: () => undefined,
        callbacks: {
          githubCallbackUrl: "http://127.0.0.1:8787/github-callback",
          oneDriveCallbackUrl: "http://127.0.0.1:8787/onedrive-callback",
          waitForGithubCallback,
          waitForOneDriveCallback,
          close: () => Promise.resolve(),
        },
      });

      expect(openBrowser).toHaveBeenCalledTimes(2);
      expect(waitForGithubCallback).toHaveBeenCalledTimes(1);
      expect(waitForOneDriveCallback).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(
        "http://api.example.test/auth/url?returnUri=http%3A%2F%2F127.0.0.1%3A8787%2Fgithub-callback",
        undefined,
      );
      expect(fetchFn).toHaveBeenCalledWith(
        "http://api.example.test/onedrive/auth-url?harnessCallbackUri=http%3A%2F%2F127.0.0.1%3A8787%2Fonedrive-callback",
        expect.objectContaining({ headers: { Authorization: "Bearer jwt-1" } }),
      );
      expect(fetchFn).not.toHaveBeenCalledWith(
        expect.stringContaining("onedrive/connect?"),
        expect.anything(),
      );
      expect(state.github?.jwt).toBe("jwt-2");
      expect(state.github?.refreshToken).toBe("refresh-2");
      expect(state.oneDrive?.connected).toBe(true);

      const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
        github?: { jwt?: string; refreshToken?: string; username?: string };
        oneDrive?: { connected?: boolean; lastStatus?: string };
      };
      expect(persisted.github?.username).toBe("alice");
      expect(persisted.github?.jwt).toBe("jwt-2");
      expect(persisted.oneDrive?.lastStatus).toBe("connected");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
