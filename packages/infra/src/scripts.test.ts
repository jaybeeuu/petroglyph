import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentFilePath = fileURLToPath(import.meta.url);
const infraDirectory = resolve(dirname(currentFilePath), "..");
const scriptsDirectory = resolve(infraDirectory, "scripts");

function readScript(name: string): string {
  return readFileSync(resolve(scriptsDirectory, name), "utf8");
}

function readInfraFile(name: string): string {
  return readFileSync(resolve(infraDirectory, name), "utf8");
}

describe("infra script workflow split", () => {
  describe("bootstrap.sh", () => {
    it("creates the Terraform state bucket", () => {
      const script = readScript("bootstrap.sh");
      expect(script).toMatch(/TF_STATE_BUCKET/);
      expect(script).toMatch(/s3api.*create-bucket|create-bucket.*s3api/);
    });

    it("creates the DynamoDB lock table", () => {
      const script = readScript("bootstrap.sh");
      expect(script).toMatch(/dynamodb.*create-table|create-table.*dynamodb/);
    });

    it("creates the Lambda artifact bucket and uploads a placeholder zip", () => {
      const script = readScript("bootstrap.sh");
      expect(script).toMatch(/LAMBDA_ARTIFACT_BUCKET/);
      expect(script).toMatch(/placeholder.*lambda\.zip|lambda\.zip.*placeholder/i);
    });

    it("does not invoke terraform", () => {
      const script = readScript("bootstrap.sh");
      expect(script).not.toMatch(/^\s*(?:AWS_PROFILE=\S+\s+)?terraform\b/m);
    });

    it("updates the deploy managed policy when the live version drifts", () => {
      const script = readScript("bootstrap.sh");
      expect(script).toMatch(/get-policy-version/);
      expect(script).toMatch(/create-policy-version/);
      expect(script).toMatch(/--set-as-default/);
      // The live document is parsed as JSON by the drift check, so it must
      // be fetched in a parseable format (--output text flattens dicts and
      // lists into a text table that JSON.parse cannot read).
      expect(script).toMatch(
        /get-policy-version[\s\S]*--query 'PolicyVersion\.Document'[\s\S]*--output json/,
      );
    });

    it("prunes the oldest policy versions to stay under the IAM limit", () => {
      const script = readScript("bootstrap.sh");
      expect(script).toMatch(/list-policy-versions/);
      expect(script).toMatch(/delete-policy-version/);
    });

    it("creates a deploy role per environment, each trusting its own GitHub environment", () => {
      const script = readScript("bootstrap.sh");
      expect(script).toMatch(/for DEPLOY_ENVIRONMENT in production qa; do/);
      expect(script).toMatch(/petroglyph-github-actions-deploy-\$\{DEPLOY_ENVIRONMENT\}/);
      expect(script).toMatch(/environment:\$\{DEPLOY_ENVIRONMENT\}/);
    });

    it("scopes the plan role's SSM read to the namespaced production parameter", () => {
      const script = readScript("bootstrap.sh");
      expect(script).toMatch(/parameter\/petroglyph\/production\/onedrive\/client-id/);
    });
  });

  describe("SSM parameter namespacing", () => {
    it("names every parameter by the active workspace", () => {
      const main = readInfraFile("main.tf");
      const ssm = readInfraFile("ssm.tf");
      expect(main).toMatch(/ssm_parameter_prefix\s*=\s*"\/petroglyph\/\$\{terraform\.workspace\}"/);
      expect(ssm).toMatch(/local\.ssm_parameter_prefix/);
      expect(ssm).not.toMatch(/name\s*=\s*"\/petroglyph\//);
    });

    it("scopes the Lambda SSM read grants to the active workspace", () => {
      const iam = readInfraFile("iam.tf");
      expect(iam).toMatch(
        /ssm_parameter_arn_prefix\s*=\s*"\$\{local\.ssm_arn_prefix\}\$\{local\.ssm_parameter_prefix\}"/,
      );
      expect(iam).not.toMatch(/ssm_arn_prefix\}\/petroglyph\//);
    });
  });

  describe("tf-apply.sh", () => {
    it("runs terraform init with backend config", () => {
      const script = readScript("tf-apply.sh");
      expect(script).toMatch(/terraform init/);
      expect(script).toMatch(/-backend-config/);
    });

    it("selects or creates the workspace", () => {
      const script = readScript("tf-apply.sh");
      expect(script).toMatch(/terraform workspace select/);
    });

    it("runs terraform plan with a destroy guard", () => {
      const script = readScript("tf-apply.sh");
      expect(script).toMatch(/terraform plan/);
      expect(script).toMatch(/to destroy/);
    });

    it("runs terraform apply", () => {
      const script = readScript("tf-apply.sh");
      expect(script).toMatch(/terraform apply/);
    });

    it("accepts --profile and --workspace flags", () => {
      const script = readScript("tf-apply.sh");
      expect(script).toMatch(/--profile/);
      expect(script).toMatch(/--workspace/);
    });
  });

  describe("package.json scripts", () => {
    it("exposes a bootstrap script", () => {
      const pkg = JSON.parse(readInfraFile("package.json")) as {
        scripts: { [key: string]: string };
      };
      expect(pkg.scripts).toHaveProperty("bootstrap");
      expect(pkg.scripts["bootstrap"]).toMatch(/bootstrap\.sh/);
    });

    it("exposes a tf:apply script", () => {
      const pkg = JSON.parse(readInfraFile("package.json")) as {
        scripts: { [key: string]: string };
      };
      expect(pkg.scripts).toHaveProperty("tf:apply");
      expect(pkg.scripts["tf:apply"]).toMatch(/tf-apply\.sh/);
    });

    it("exposes a migrate-ssm script", () => {
      const pkg = JSON.parse(readInfraFile("package.json")) as {
        scripts: { [key: string]: string };
      };
      expect(pkg.scripts).toHaveProperty("migrate-ssm");
      expect(pkg.scripts["migrate-ssm"]).toMatch(/migrate-ssm-namespace\.sh/);
    });
  });
});
