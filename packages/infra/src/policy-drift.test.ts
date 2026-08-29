import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentFilePath = fileURLToPath(import.meta.url);
const infraDirectory = resolve(dirname(currentFilePath), "..");
const scriptsDirectory = resolve(infraDirectory, "scripts");

/** The deploy-role policy embeds `${ACCOUNT_ID}`; the script expands it at apply time. */
const accountId = "${ACCOUNT_ID}";

function readScript(name: string): string {
  return readFileSync(resolve(scriptsDirectory, name), "utf8");
}

function readInfraFile(name: string): string {
  return readFileSync(resolve(infraDirectory, name), "utf8");
}

/**
 * The production DynamoDB table names declared by every `aws_dynamodb_table`
 * resource in dynamodb.tf, e.g. `petroglyph-refresh-tokens-production`.
 * Names are built as `petroglyph-<name>-${terraform.workspace}`; the deploy
 * role only needs the production tables, so the workspace is fixed to
 * `production`.
 */
function productionTableNames(dynamodbTf: string): string[] {
  const resourcePattern = /resource\s+"aws_dynamodb_table"\s+"[\w-]+"\s*\{[\s\S]*?\n\}/g;
  const names: string[] = [];
  for (const match of dynamodbTf.matchAll(resourcePattern)) {
    const nameMatch = match[0].match(/^\s{2}name\s*=\s*"([^"]+)"/m);
    if (nameMatch === null) {
      throw new Error("aws_dynamodb_table resource without a top-level name attribute");
    }
    names.push((nameMatch[1] ?? "").replace("${terraform.workspace}", "production"));
  }
  return names;
}

/** The DynamoDB table ARNs in the DynamoDbProjectTables statement of the deploy-role policy. */
function projectTableArns(bootstrapScript: string): string[] {
  const statementMatch = bootstrapScript.match(
    /"Sid"\s*:\s*"DynamoDbProjectTables"[\s\S]*?"Resource"\s*:\s*\[([\s\S]*?)\]/,
  );
  if (statementMatch === null) {
    throw new Error("DynamoDbProjectTables statement not found in bootstrap.sh");
  }
  return [...(statementMatch[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

/** The Lambda actions in the LambdaProjectFunctions statement of the deploy-role policy. */
function lambdaProjectFunctionsActions(bootstrapScript: string): string[] {
  const statementMatch = bootstrapScript.match(
    /"Sid"\s*:\s*"LambdaProjectFunctions"[\s\S]*?"Action"\s*:\s*\[([\s\S]*?)\]/,
  );
  if (statementMatch === null) {
    throw new Error("LambdaProjectFunctions statement not found in bootstrap.sh");
  }
  return [...(statementMatch[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

/** The lambda EventSourceMapping CRUD actions needed once sync-worker (SQS) and sync-relay (DynamoDB stream) are wired into CD. */
const eventSourceMappingActions: string[] = [
  "lambda:CreateEventSourceMapping",
  "lambda:DeleteEventSourceMapping",
  "lambda:GetEventSourceMapping",
  "lambda:ListEventSourceMappings",
  "lambda:UpdateEventSourceMapping",
];

describe("deploy-role DynamoDbProjectTables policy", () => {
  const declaredTables = productionTableNames(readInfraFile("dynamodb.tf"));
  const policyTableArns = projectTableArns(readScript("bootstrap.sh"));

  it("extracts the production table names declared in dynamodb.tf", () => {
    expect(declaredTables).toEqual(
      expect.arrayContaining([
        "petroglyph-users-production",
        "petroglyph-refresh-tokens-production",
        "petroglyph-sync-profiles-production",
        "petroglyph-file-records-production",
        "petroglyph-delta-tokens-production",
        "petroglyph-sync-jobs-production",
      ]),
    );
  });

  it.each(declaredTables)("covers the %s table in the deploy-role policy", (tableName) => {
    expect(policyTableArns).toContain(`arn:aws:dynamodb:eu-west-2:${accountId}:table/${tableName}`);
  });
});

describe("deploy-role LambdaProjectFunctions policy", () => {
  const policyActions = lambdaProjectFunctionsActions(readScript("bootstrap.sh"));

  it.each(eventSourceMappingActions)("covers the %s action", (action) => {
    expect(policyActions).toContain(action);
  });
});
