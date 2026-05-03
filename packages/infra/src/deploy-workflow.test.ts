import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentFilePath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(currentFilePath), "../../..");
const deployWorkflowPath = resolve(repoRoot, ".github/workflows/deploy.yml");

function readDeployWorkflow(): string {
  return readFileSync(deployWorkflowPath, "utf8");
}

describe("Deploy workflow artifact handling", () => {
  it("does not use github.sha as the S3 artifact key", () => {
    const workflow = readDeployWorkflow();
    expect(workflow).not.toMatch(/lambda-\$\{\{\s*github\.sha\s*\}\}\.zip/);
  });

  it("computes a content hash from the lambda zip before uploading", () => {
    const workflow = readDeployWorkflow();
    // The workflow must compute a SHA256 (or similar) of the zip file
    expect(workflow).toMatch(/sha256sum.*lambda\.zip/);
  });

  it("skips the S3 upload when an artifact with that content hash already exists", () => {
    const workflow = readDeployWorkflow();
    // The workflow must guard the upload with an existence check
    expect(workflow).toMatch(/head-object[\s\S]*lambda\.zip|lambda\.zip[\s\S]*head-object/);
  });

  it("passes the content-hash-based key to terraform apply", () => {
    const workflow = readDeployWorkflow();
    // api_zip_s3_key must reference a step output or env var, not github.sha
    expect(workflow).toMatch(/api_zip_s3_key.*steps\.|api_zip_s3_key.*env\./);
  });

  it("captures the deployed Lambda function URL from Terraform output", () => {
    const workflow = readDeployWorkflow();
    expect(workflow).toMatch(/terraform output -raw api_function_url/);
  });

  it("runs the deployed smoke test after terraform apply", () => {
    const workflow = readDeployWorkflow();
    expect(workflow).toMatch(
      /Terraform apply[\s\S]*Capture API function URL[\s\S]*Smoke test deployed API[\s\S]*LAMBDA_FUNCTION_URL:\s*\$\{\{\s*steps\.api-function-url\.outputs\.url\s*\}\}[\s\S]*pnpm --filter @petroglyph\/api smoke-test/,
    );
  });
});
