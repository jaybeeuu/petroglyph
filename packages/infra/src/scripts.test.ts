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

interface DeployPolicyStatement {
  Sid?: string | undefined;
  Resource?: string | readonly string[] | undefined;
}

interface DeployPolicyDocument {
  Statement?: readonly DeployPolicyStatement[] | undefined;
}

/** Table names `DynamoDbProjectTables` grants, read out of the policy document bootstrap.sh builds. */
function readGrantedTableNames(): string[] {
  const heredoc = /POLICY_DOC_ALL=\$\(cat << EOF\n([\s\S]*?)\nEOF\n\)/.exec(
    readScript("bootstrap.sh"),
  );
  const policyDocument = heredoc?.[1];
  if (policyDocument === undefined) {
    throw new Error("bootstrap.sh builds no POLICY_DOC_ALL document");
  }

  const policy = JSON.parse(policyDocument) as DeployPolicyDocument;
  const statement = policy.Statement?.find(
    (candidate) => candidate.Sid === "DynamoDbProjectTables",
  );
  if (statement === undefined) {
    throw new Error("the deploy policy has no DynamoDbProjectTables statement");
  }

  const resources = statement.Resource;
  const arns = typeof resources === "string" ? [resources] : (resources ?? []);
  const tableNames: string[] = [];
  for (const arn of arns) {
    const tableName =
      /^arn:aws:dynamodb:eu-west-2:\$\{ACCOUNT_ID\}:table\/(?<tableName>[^/]+)$/.exec(arn)
        ?.groups?.["tableName"];
    if (tableName !== undefined) {
      tableNames.push(tableName);
    }
  }
  return tableNames;
}

/** Table names dynamodb.tf declares, named for the workspace the deploy role applies. */
function readDeclaredTableNames(): string[] {
  const terraform = readInfraFile("dynamodb.tf");
  const tableNames: string[] = [];
  for (const declaration of terraform.matchAll(
    /resource "aws_dynamodb_table" "[a-z_]+" \{\n\s*name\s*=\s*"([^"]+)"/g,
  )) {
    const tableName = declaration[1];
    if (tableName !== undefined) {
      tableNames.push(tableName.replaceAll("${terraform.workspace}", "${DEPLOY_ENVIRONMENT}"));
    }
  }
  return tableNames;
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

    // The deploy role applies the DynamoDB resources, so a table it cannot reach
    // fails `terraform apply` and blocks the deploy. Compare the two lists rather
    // than restating them, so a new table cannot land without its ARN.
    it("grants the deploy role every DynamoDB table terraform declares", () => {
      const declaredTableNames = readDeclaredTableNames();
      const grantedTableNames = readGrantedTableNames();

      expect(declaredTableNames.length).toBeGreaterThan(0);
      expect(declaredTableNames.filter((name) => !grantedTableNames.includes(name))).toEqual([]);
    });

    // The deploy role applies the resource removal, so the apply that destroys a
    // retired table still calls DeleteTable. The grant must outlive the destroy;
    // a follow-up retires the ARN once the table is gone.
    it("keeps the retired delta-states grant while the same apply destroys its table", () => {
      const declaredTableNames = readDeclaredTableNames();
      const grantedTableNames = readGrantedTableNames();

      expect(declaredTableNames).not.toContain("petroglyph-delta-states-${DEPLOY_ENVIRONMENT}");
      expect(grantedTableNames).toContain("petroglyph-delta-states-${DEPLOY_ENVIRONMENT}");
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
