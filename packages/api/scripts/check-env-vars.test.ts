import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const apiDir = join(__dirname, "..");
const infraDir = join(__dirname, "..", "..", "infra");

/**
 * Extract environment variable names from Terraform Lambda config.
 * Parses lambda_api.tf to find all env vars configured in the Lambda environment block.
 */
function extractTerraformEnvVars(): Set<string> {
  const terraformFile = join(infraDir, "lambda_api.tf");
  const content = readFileSync(terraformFile, "utf-8");

  const envVars = new Set<string>();

  // Find the environment block and extract variable names
  // We need to handle nested braces in Terraform string interpolations like ${...}
  const envBlockStart = content.indexOf("environment");
  if (envBlockStart === -1) {
    throw new Error("Could not find environment block in lambda_api.tf");
  }

  const variablesStart = content.indexOf("variables = {", envBlockStart);
  if (variablesStart === -1) {
    throw new Error("Could not find variables block in lambda_api.tf");
  }

  // Find the closing brace by counting braces
  let braceCount = 0;
  let inVariablesBlock = false;
  let variablesEnd = -1;

  for (let i = variablesStart; i < content.length; i++) {
    if (content[i] === "{") {
      braceCount++;
      inVariablesBlock = true;
    } else if (content[i] === "}") {
      braceCount--;
      if (inVariablesBlock && braceCount === 0) {
        variablesEnd = i;
        break;
      }
    }
  }

  if (variablesEnd === -1) {
    throw new Error("Could not find end of variables block in lambda_api.tf");
  }

  const envBlock = content.substring(variablesStart, variablesEnd);

  // Match variable assignments like: SOME_VAR = "value" or SOME_VAR = aws_resource.name
  // Handle multiple spaces/tabs around the = sign
  const varPattern = /^\s*([A-Z_][A-Z0-9_]*)\s*=/gm;
  let match;
  while ((match = varPattern.exec(envBlock)) !== null) {
    envVars.add(match[1]);
  }

  return envVars;
}

/**
 * Extract environment variable reads from TypeScript source files.
 * Scans all .ts files in packages/api/src for process.env reads.
 */
function extractCodeEnvVarReads(): Set<string> {
  const srcDir = join(apiDir, "src");
  const envVars = new Set<string>();

  // Read all TypeScript files
  const files: string[] = [];

  function walkDir(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        walkDir(fullPath);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        files.push(fullPath);
      }
    }
  }

  walkDir(srcDir);

  // Match process.env["VAR_NAME"] and process.env.VAR_NAME
  const bracketPattern = /process\.env\["([A-Z_][A-Z0-9_]*)"\]/g;
  const dotPattern = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
  const destructurePattern =
    /const\s*{\s*([A-Z_][A-Z0-9_]*(?:\s*,\s*[A-Z_][A-Z0-9_]*)*)\s*}\s*=\s*process\.env/g;

  for (const file of files) {
    const content = readFileSync(file, "utf-8");

    let match;

    // Match bracket notation
    while ((match = bracketPattern.exec(content)) !== null) {
      envVars.add(match[1]);
    }

    // Match dot notation
    while ((match = dotPattern.exec(content)) !== null) {
      envVars.add(match[1]);
    }

    // Match destructuring
    while ((match = destructurePattern.exec(content)) !== null) {
      const vars = match[1].split(/\s*,\s*/);
      for (const v of vars) {
        envVars.add(v.trim());
      }
    }
  }

  return envVars;
}

describe("Lambda environment variable configuration", () => {
  it("all env vars read in code are configured in Terraform (or populated by SSM init)", () => {
    const terraformEnvVars = extractTerraformEnvVars();
    const codeEnvVars = extractCodeEnvVarReads();

    // These vars are populated by SSM init code in index.ts, not directly by Terraform
    const ssmPopulatedVars = new Set([
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_SECRET",
      "JWT_SIGNING_SECRET",
      "JWT_PRIVATE_KEY",
      "JWT_PUBLIC_KEY",
      "MICROSOFT_CLIENT_ID", // mapped from ONEDRIVE_CLIENT_ID_SSM_PATH
    ]);

    // These vars have defaults in code and are optional
    const optionalVars = new Set(["ONEDRIVE_FOLDER"]);

    const missingInTerraform: string[] = [];

    for (const envVar of codeEnvVars) {
      if (
        !terraformEnvVars.has(envVar) &&
        !ssmPopulatedVars.has(envVar) &&
        !optionalVars.has(envVar)
      ) {
        missingInTerraform.push(envVar);
      }
    }

    if (missingInTerraform.length > 0) {
      const details = missingInTerraform.map((v) => `  - ${v}`).join("\n");
      const errorMsg = `Code reads env vars not configured in Terraform lambda_api.tf:\n${details}\n\nAdd these to the environment.variables block in packages/infra/lambda_api.tf`;
      throw new Error(errorMsg);
    }

    expect(missingInTerraform).toEqual([]);
  });

  it("Terraform sets the expected core env vars", () => {
    const terraformEnvVars = extractTerraformEnvVars();

    // These env vars MUST be configured for the Lambda to work
    const requiredVars = [
      "GITHUB_CLIENT_ID_SSM_PATH",
      "GITHUB_CLIENT_SECRET_SSM_PATH",
      "JWT_SIGNING_SECRET_SSM_PATH",
      "REFRESH_TOKENS_TABLE",
      "USERS_TABLE",
    ];

    for (const varName of requiredVars) {
      expect(
        terraformEnvVars.has(varName),
        `Expected ${varName} to be configured in lambda_api.tf`,
      ).toBe(true);
    }
  });

  it("documents current env var coverage", () => {
    const terraformEnvVars = extractTerraformEnvVars();
    const codeEnvVars = extractCodeEnvVarReads();

    // This test documents what we found, for visibility
    console.log(`\nEnvironment variable coverage:`);
    console.log(`  Terraform configures: ${terraformEnvVars.size} env vars`);
    console.log(`  Code reads: ${codeEnvVars.size} env vars`);
    console.log(`\nTerraform env vars: ${Array.from(terraformEnvVars).sort().join(", ")}`);
    console.log(`\nCode env var reads: ${Array.from(codeEnvVars).sort().join(", ")}`);

    expect(true).toBe(true);
  });
});
