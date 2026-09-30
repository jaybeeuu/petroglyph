import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./index.js";

describe("createApp env wiring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails fast when STAGED_PDFS_BUCKET is not set", () => {
    vi.stubEnv("STAGED_PDFS_BUCKET", "");

    expect(() => createApp()).toThrow("STAGED_PDFS_BUCKET");
  });
});
