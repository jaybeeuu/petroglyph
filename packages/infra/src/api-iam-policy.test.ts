import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * LocalStack does not enforce IAM, so a suite that exercises the api against it
 * stays green while the deployed api gets AccessDeniedException for an action
 * its role never grants. This file compares two artefacts instead: the actions
 * the api code sends, and the actions `packages/infra/iam.tf` grants the api
 * role. A gap between them fails here, where no AWS account is needed.
 */

const infraDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(infraDir, "../..");

/** The AWS SDK command class per IAM action the command authorises. */
const COMMAND_ACTIONS: Readonly<{ [command: string]: string }> = {
  GetCommand: "dynamodb:GetItem",
  PutCommand: "dynamodb:PutItem",
  UpdateCommand: "dynamodb:UpdateItem",
  DeleteCommand: "dynamodb:DeleteItem",
  QueryCommand: "dynamodb:Query",
  ScanCommand: "dynamodb:Scan",
  BatchWriteCommand: "dynamodb:BatchWriteItem",
  BatchGetCommand: "dynamodb:BatchGetItem",
  TransactWriteCommand: "dynamodb:TransactWriteItems",
  GetObjectCommand: "s3:GetObject",
  PutObjectCommand: "s3:PutObject",
  DeleteObjectCommand: "s3:DeleteObject",
  DeleteObjectsCommand: "s3:DeleteObjects",
  ListObjectsV2Command: "s3:ListBucket",
  SendMessageCommand: "sqs:SendMessage",
  GetParameterCommand: "ssm:GetParameter",
  GetParametersCommand: "ssm:GetParameters",
};

/**
 * Commands the api sends only through a `@petroglyph/staging-contracts` store
 * adapter, so no `new …Command` appears in the api's own source. The adapter
 * file and command are checked, so an entry cannot outlive the call it
 * documents.
 */
const VIA_STORE_ADAPTERS: readonly {
  action: string;
  adapter: string;
  command: string;
}[] = [
  {
    // DynamoDBStagedIndexStore.removeMany, which the profile path reset calls.
    action: "dynamodb:BatchWriteItem",
    adapter: "packages/staging-contracts/src/index-store-ddb.ts",
    command: "BatchWriteCommand",
  },
  {
    // S3StagedObjectStore.deleteMany, which the profile path reset calls.
    action: "s3:DeleteObjects",
    adapter: "packages/staging-contracts/src/object-store.ts",
    command: "DeleteObjectsCommand",
  },
];

const COMMAND_PATTERN = /new ([A-Z][A-Za-z]*Command)\b/g;

function commandNames(source: string): string[] {
  return [...source.matchAll(COMMAND_PATTERN)].map((match) => match[1] ?? "");
}

/** The api lambda's own source: every `*.ts` in the package except its tests. */
function apiSendsSource(): { action: string; file: string }[] {
  const apiSourceDir = join(repoRoot, "packages/api/src");
  return readdirSync(apiSourceDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .flatMap((name) => {
      const source = readFileSync(join(apiSourceDir, name), "utf8");
      return commandNames(source).map((command) => ({
        action: COMMAND_ACTIONS[command] ?? command,
        file: `packages/api/src/${name}`,
      }));
    });
}

/** Adapter calls the api makes indirectly, each with the adapter that sends it. */
function apiSendsThroughAdapters(): { action: string; file: string }[] {
  return VIA_STORE_ADAPTERS.map(({ action, adapter }) => ({ action, file: adapter }));
}

/** Entries above whose adapter no longer sends the command they claim. */
function staleAdapterClaims(): string[] {
  return VIA_STORE_ADAPTERS.filter(({ adapter, command }) => {
    const source = readFileSync(join(repoRoot, adapter), "utf8");
    return !commandNames(source).includes(command);
  }).map(({ action, adapter, command }) => `${action} claims ${adapter} sends ${command}`);
}

/**
 * The statements of `aws_iam_role_policy.petroglyph_api_policy`, one string
 * each. The policy is `jsonencode({...})` over a list, so its statements are
 * the 6-space-indented objects inside that list.
 */
function apiPolicyStatements(): string[] {
  const terraform = readFileSync(join(infraDir, "iam.tf"), "utf8");
  const policyStart = terraform.indexOf('resource "aws_iam_role_policy" "petroglyph_api_policy"');
  if (policyStart === -1) {
    throw new Error(
      'iam.tf no longer declares resource "aws_iam_role_policy" "petroglyph_api_policy"',
    );
  }
  const nextResource = terraform.indexOf('\nresource "', policyStart + 1);
  const policy = terraform.slice(policyStart, nextResource === -1 ? undefined : nextResource);
  return [...policy.matchAll(/^ {6}\{\n([\s\S]*?)^ {6}\},$/gm)].map((match) => match[1] ?? "");
}

/** Actions the api role allows: every `service:Action` string in an Allow. */
function actionsTheApiRoleGrants(): Set<string> {
  const granted = new Set<string>();
  for (const statement of apiPolicyStatements()) {
    if (!/Effect\s*=\s*"Allow"/.test(statement)) {
      continue;
    }
    for (const match of statement.matchAll(/"((?:dynamodb|s3|sqs|ssm):[A-Za-z]+)"/g)) {
      granted.add(match[1] ?? "");
    }
  }
  return granted;
}

/** DynamoDB tables the api lambda is given the name of, as Terraform resources. */
function tablesTheApiLambdaIsWiredTo(): string[] {
  const lambdaApi = readFileSync(join(infraDir, "lambda_api.tf"), "utf8");
  return [...lambdaApi.matchAll(/_TABLE\s*=\s*aws_dynamodb_table\.([a-z_]+)\.name/g)].map(
    (match) => match[1] ?? "",
  );
}

/** DynamoDB tables the api role's policy names the ARN of. */
function tablesTheApiRoleNames(): Set<string> {
  return new Set(
    [
      ...apiPolicyStatements()
        .join("\n")
        .matchAll(/aws_dynamodb_table\.([a-z_]+)\.arn/g),
    ].map((match) => match[1] ?? ""),
  );
}

describe("the api role policy in iam.tf", () => {
  it("names an IAM action for every command the api sends", () => {
    const unmapped = apiSendsSource()
      .filter(({ action }) => !action.includes(":"))
      .map(({ action, file }) => `${action} (${file})`);

    expect(unmapped).toEqual([]);
  });

  it("claims no adapter call the adapters no longer send", () => {
    expect(staleAdapterClaims()).toEqual([]);
  });

  it("grants every action the api code sends", () => {
    const granted = actionsTheApiRoleGrants();

    const ungranted = [...apiSendsSource(), ...apiSendsThroughAdapters()]
      .filter(({ action }) => !granted.has(action))
      .map(({ action, file }) => `${action} (sent by ${file})`);

    expect(ungranted).toEqual([]);
  });

  it("names every DynamoDB table the api lambda is wired to", () => {
    const named = tablesTheApiRoleNames();

    const unnamed = tablesTheApiLambdaIsWiredTo().filter((table) => !named.has(table));

    expect(unnamed).toEqual([]);
  });
});
