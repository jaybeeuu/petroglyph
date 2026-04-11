import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(currentFilePath), "../../..");
const cdWorkflowPath = resolve(repoRoot, ".github/workflows/cd.yml");

function readCdWorkflow(): string {
  return readFileSync(cdWorkflowPath, "utf8");
}

describe("CD workflow artifact handling", () => {
  it("does not use github.sha as the S3 artifact key", () => {
    const workflow = readCdWorkflow();
    expect(workflow).not.toMatch(/lambda-\$\{\{\s*github\.sha\s*\}\}\.zip/);
  });

  it("computes a content hash from the lambda zip before uploading", () => {
    const workflow = readCdWorkflow();
    // The workflow must compute a SHA256 (or similar) of the zip file
    expect(workflow).toMatch(/sha256sum.*lambda\.zip/);
  });

  it("skips the S3 upload when an artifact with that content hash already exists", () => {
    const workflow = readCdWorkflow();
    // The workflow must guard the upload with an existence check
    expect(workflow).toMatch(/head-object[\s\S]*lambda\.zip|lambda\.zip[\s\S]*head-object/);
  });

  it("passes the content-hash-based key to terraform apply", () => {
    const workflow = readCdWorkflow();
    // api_zip_s3_key must reference a step output or env var, not github.sha
    expect(workflow).toMatch(/api_zip_s3_key.*steps\.|api_zip_s3_key.*env\./);
  });
});
