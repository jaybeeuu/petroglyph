import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateTableCommand,
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  type AttributeDefinition,
  type GlobalSecondaryIndex,
  type KeySchemaElement,
  type ProjectionType,
  type ScalarAttributeType,
} from "@aws-sdk/client-dynamodb";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The registry table's schema lives in `dynamodb.tf`, so the declaration is
// what these tests read into a real DynamoDB and then use the way its callers
// will: the subscribe action and the renewer by `(profileId, provider)`, the
// webhook by `subscriptionId`, and the hourly tick by the `expiry` window.
// A declaration that loses a key, an index or an attribute definition fails
// here — either DynamoDB rejects the table, or the lookup the caller performs
// stops answering.
const REGION = "eu-west-2";
const CREDENTIALS = { accessKeyId: "test", secretAccessKey: "test" };
const TABLE_NAME = "petroglyph-graph-subscriptions-int";
const INFRA_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface DeclaredSecondaryIndex {
  readonly name: string;
  readonly hashKey: string;
  readonly rangeKey?: string | undefined;
  readonly projectionType: ProjectionType;
}

interface DeclaredTable {
  readonly hashKey: string;
  readonly rangeKey?: string | undefined;
  readonly attributes: readonly { readonly name: string; readonly type: ScalarAttributeType }[];
  readonly secondaryIndexes: readonly DeclaredSecondaryIndex[];
}

/** Returns the `resource "<type>" "<name>" { … }` body, brace-matched. */
function readResourceBlock(terraform: string, resourceType: string, name: string): string {
  const header = `resource "${resourceType}" "${name}" {`;
  const start = terraform.indexOf(header);
  if (start === -1) {
    throw new Error(`dynamodb.tf declares no ${resourceType} "${name}"`);
  }
  return readBlockAt(terraform, start + header.length - 1);
}

/** Returns every `name { … }` body in a block, brace-matched. */
function readNestedBlocks(block: string, name: string): string[] {
  const blocks: string[] = [];
  for (let index = block.indexOf(`${name} {`); index !== -1; ) {
    const open = block.indexOf("{", index);
    const nested = readBlockAt(block, open);
    blocks.push(nested);
    index = block.indexOf(`${name} {`, open + nested.length);
  }
  return blocks;
}

/** Returns the braces-delimited body that starts at `open`, including its braces. */
function readBlockAt(terraform: string, open: number): string {
  let depth = 0;
  for (let index = open; index < terraform.length; index += 1) {
    if (terraform[index] === "{") {
      depth += 1;
    }
    if (terraform[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        return terraform.slice(open, index + 1);
      }
    }
  }
  throw new Error(`the block opened at offset ${open} is never closed`);
}

function readProperty(block: string, property: string): string | undefined {
  return new RegExp(`^\\s*${property}\\s*=\\s*"([^"]*)"\\s*$`, "m").exec(block)?.[1];
}

function requireProperty(block: string, property: string, owner: string): string {
  const value = readProperty(block, property);
  if (value === undefined) {
    throw new Error(`the ${owner} declaration names no ${property}`);
  }
  return value;
}

function parseAttributeType(value: string, owner: string): ScalarAttributeType {
  if (value === "S" || value === "N" || value === "B") {
    return value;
  }
  throw new Error(`the ${owner} declaration uses attribute type ${value}`);
}

function parseProjectionType(value: string, owner: string): ProjectionType {
  if (value === "ALL" || value === "KEYS_ONLY" || value === "INCLUDE") {
    return value;
  }
  throw new Error(`the ${owner} declaration uses projection type ${value}`);
}

function readDeclaredTable(): DeclaredTable {
  const block = readResourceBlock(
    readFileSync(resolve(INFRA_DIRECTORY, "dynamodb.tf"), "utf8"),
    "aws_dynamodb_table",
    "graph_subscriptions",
  );
  return {
    hashKey: requireProperty(block, "hash_key", "graph_subscriptions"),
    rangeKey: readProperty(block, "range_key"),
    attributes: readNestedBlocks(block, "attribute").map((attributeBlock) => ({
      name: requireProperty(attributeBlock, "name", "graph_subscriptions attribute"),
      type: parseAttributeType(
        requireProperty(attributeBlock, "type", "graph_subscriptions attribute"),
        "graph_subscriptions",
      ),
    })),
    secondaryIndexes: readNestedBlocks(block, "global_secondary_index").map((indexBlock) => ({
      name: requireProperty(indexBlock, "name", "graph_subscriptions index"),
      hashKey: requireProperty(indexBlock, "hash_key", "graph_subscriptions index"),
      ...(readProperty(indexBlock, "range_key") === undefined
        ? {}
        : { rangeKey: readProperty(indexBlock, "range_key") }),
      projectionType: parseProjectionType(
        requireProperty(indexBlock, "projection_type", "graph_subscriptions index"),
        "graph_subscriptions",
      ),
    })),
  };
}

function keySchema(hashKey: string, rangeKey: string | undefined): KeySchemaElement[] {
  const partitionKey: KeySchemaElement = { AttributeName: hashKey, KeyType: "HASH" };
  if (rangeKey === undefined) {
    return [partitionKey];
  }
  const sortKey: KeySchemaElement = { AttributeName: rangeKey, KeyType: "RANGE" };
  return [partitionKey, sortKey];
}

function toGlobalSecondaryIndex(index: DeclaredSecondaryIndex): GlobalSecondaryIndex {
  return {
    IndexName: index.name,
    KeySchema: keySchema(index.hashKey, index.rangeKey),
    Projection: { ProjectionType: index.projectionType },
  };
}

function attributeDefinitions(attributes: DeclaredTable["attributes"]): AttributeDefinition[] {
  return attributes.map((attribute) => ({
    AttributeName: attribute.name,
    AttributeType: attribute.type,
  }));
}

describe("subscription registry table", () => {
  let container: StartedTestContainer;
  let dynamo: DynamoDBClient;

  beforeAll(async () => {
    container = await new GenericContainer("localstack/localstack:3.8.1")
      .withExposedPorts(4566)
      .withEnvironment({
        SERVICES: "dynamodb",
        AWS_ACCESS_KEY_ID: CREDENTIALS.accessKeyId,
        AWS_SECRET_ACCESS_KEY: CREDENTIALS.secretAccessKey,
        AWS_DEFAULT_REGION: REGION,
      })
      .withWaitStrategy(Wait.forLogMessage(/Ready\./))
      .withStartupTimeout(120_000)
      .start();

    dynamo = new DynamoDBClient({
      region: REGION,
      endpoint: `http://localhost:${container.getMappedPort(4566)}`,
      credentials: CREDENTIALS,
    });

    const declared = readDeclaredTable();
    await dynamo.send(
      new CreateTableCommand({
        TableName: TABLE_NAME,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: keySchema(declared.hashKey, declared.rangeKey),
        AttributeDefinitions: attributeDefinitions(declared.attributes),
        GlobalSecondaryIndexes: declared.secondaryIndexes.map(toGlobalSecondaryIndex),
      }),
    );
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  }, 30_000);

  it("holds one registry row per profile and provider", async () => {
    const rows: readonly (readonly [string, string])[] = [
      ["onedrive", "subscription-a"],
      ["dropbox", "subscription-c"],
    ];
    for (const [provider, subscriptionId] of rows) {
      await dynamo.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: {
            profileId: { S: "profile-a" },
            provider: { S: provider },
            subscriptionId: { S: subscriptionId },
            expiry: { N: "1000" },
          },
        }),
      );
    }

    // One profile holds both rows, so profileId is the partition key; the second
    // write did not overwrite the first, so provider is its sort key. The query
    // names only the partition key, which DynamoDB answers for the hash key and
    // for no other element of the schema.
    const stored = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "profileId = :profileId",
        ExpressionAttributeValues: { ":profileId": { S: "profile-a" } },
      }),
    );

    expect(stored.Items?.map((item) => item["provider"])).toEqual([
      { S: "dropbox" },
      { S: "onedrive" },
    ]);
  }, 30_000);

  it("resolves a notification that names only its subscriptionId to the profile", async () => {
    await dynamo.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          profileId: { S: "profile-b" },
          provider: { S: "onedrive" },
          subscriptionId: { S: "subscription-b" },
          expiry: { N: "5000" },
        },
      }),
    );

    const found = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "subscriptionId-index",
        KeyConditionExpression: "subscriptionId = :subscriptionId",
        ExpressionAttributeValues: { ":subscriptionId": { S: "subscription-b" } },
      }),
    );

    expect(found.Items).toHaveLength(1);
    expect(found.Items?.[0]).toMatchObject({ profileId: { S: "profile-b" } });
  }, 30_000);

  it("returns only the subscriptions expiring inside the renewal horizon", async () => {
    // The expiry index partitions by provider, so this test's rows own their
    // own partition and the earlier tests' rows stay out of the window query.
    const rows: readonly (readonly [string, string, string])[] = [
      ["profile-inside", "subscription-inside", "1000"],
      ["profile-outside", "subscription-outside", "5000"],
    ];
    for (const [profileId, subscriptionId, expiry] of rows) {
      await dynamo.send(
        new PutItemCommand({
          TableName: TABLE_NAME,
          Item: {
            profileId: { S: profileId },
            provider: { S: "onedrive-renewal" },
            subscriptionId: { S: subscriptionId },
            expiry: { N: expiry },
          },
        }),
      );
    }

    const expiring = await dynamo.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: "expiry-index",
        KeyConditionExpression: "#provider = :provider AND expiry < :horizon",
        ExpressionAttributeNames: { "#provider": "provider" },
        ExpressionAttributeValues: {
          ":provider": { S: "onedrive-renewal" },
          ":horizon": { N: "2000" },
        },
      }),
    );

    expect(expiring.Items?.map((item) => item["profileId"])).toEqual([{ S: "profile-inside" }]);
  }, 30_000);
});
