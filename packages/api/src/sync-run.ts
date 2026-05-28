import { PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { docClient } from "./db.js";
import { resolveOneDriveAccessToken } from "./onedrive-middleware.js";

const DEFAULT_PROFILE_ID = "default";

interface GraphDeltaPage {
  value: unknown[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

interface GraphDriveFileItem {
  id: string;
  name: string;
}

interface UnknownRecord {
  [key: string]: unknown;
}

function fileRecordsTableName(): string {
  return process.env["FILE_RECORDS_TABLE"] ?? "petroglyph-file-records-default";
}

function deltaTokensTableName(): string {
  return process.env["DELTA_TOKENS_TABLE"] ?? "petroglyph-delta-tokens-default";
}

function oneDriveFolder(): string {
  return process.env["ONEDRIVE_FOLDER"] ?? "OnyxBoox";
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readDeltaToken(profileId: string): Promise<string | undefined> {
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: deltaTokensTableName(),
        Key: { profileId },
      }),
    );
    const deltaToken = result.Item?.deltaToken;
    return typeof deltaToken === "string" ? deltaToken : undefined;
  } catch (error) {
    if (error instanceof Error && error.name === "ResourceNotFoundException") {
      return undefined;
    }
    throw error;
  }
}

function buildDeltaUrl(folder: string, deltaToken?: string): string {
  const url = new URL(
    `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURI(folder)}:/delta`,
  );
  if (deltaToken) {
    url.searchParams.set("token", deltaToken);
  }
  return url.toString();
}

function parseGraphDeltaPage(value: unknown): GraphDeltaPage {
  if (!isRecord(value) || !Array.isArray(value["value"])) {
    throw new Error("Invalid Graph delta response");
  }

  const nextLink = value["@odata.nextLink"];
  const deltaLink = value["@odata.deltaLink"];

  return {
    value: value["value"],
    ...(typeof nextLink === "string" && { "@odata.nextLink": nextLink }),
    ...(typeof deltaLink === "string" && { "@odata.deltaLink": deltaLink }),
  };
}

function parseGraphDriveFileItem(value: unknown): GraphDriveFileItem | null {
  if (!isRecord(value)) {
    return null;
  }

  if (value["deleted"] !== undefined) {
    return null;
  }

  if (typeof value["id"] !== "string" || typeof value["name"] !== "string") {
    return null;
  }

  if (!isRecord(value["file"])) {
    return null;
  }

  const mimeType = value["file"]["mimeType"];
  const filename = value["name"];
  const isPdf = mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");

  if (!isPdf) {
    return null;
  }

  return {
    id: value["id"],
    name: filename,
  };
}

function extractDeltaToken(deltaLink: string): string {
  const url = new URL(deltaLink);
  return url.searchParams.get("token") ?? deltaLink;
}

async function fetchDeltaPage(url: string, accessToken: string): Promise<GraphDeltaPage> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Graph delta request failed with status ${response.status}`);
  }

  return parseGraphDeltaPage(await response.json());
}

async function writeFileRecord(file: GraphDriveFileItem, createdAt: string): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: fileRecordsTableName(),
      Item: {
        profileId: DEFAULT_PROFILE_ID,
        fileId: file.id,
        s3Key: "",
        filename: file.name,
        createdAt,
        status: "pending",
      },
    }),
  );
}

async function storeDeltaToken(profileId: string, deltaToken: string): Promise<void> {
  await docClient.send(
    new PutCommand({
      TableName: deltaTokensTableName(),
      Item: {
        profileId,
        deltaToken,
        updatedAt: new Date().toISOString(),
      },
    }),
  );
}

export async function handleSyncRun(c: Context): Promise<Response> {
  const userIdValue: unknown = c.get("userId");
  if (typeof userIdValue !== "string" || userIdValue.length === 0) {
    throw new Error("Missing userId in sync run context");
  }
  const userId = userIdValue;
  const accessToken = await resolveOneDriveAccessToken(userId);
  const startingDeltaToken = await readDeltaToken(DEFAULT_PROFILE_ID);

  let nextUrl: string | undefined = buildDeltaUrl(oneDriveFolder(), startingDeltaToken);
  let latestDeltaToken: string | undefined;
  let queued = 0;

  while (nextUrl) {
    const page = await fetchDeltaPage(nextUrl, accessToken);
    const createdAt = new Date().toISOString();

    for (const item of page.value) {
      const file = parseGraphDriveFileItem(item);
      if (!file) {
        continue;
      }

      await writeFileRecord(file, createdAt);
      queued += 1;
    }

    nextUrl = page["@odata.nextLink"];
    if (page["@odata.deltaLink"]) {
      latestDeltaToken = extractDeltaToken(page["@odata.deltaLink"]);
    }
  }

  if (latestDeltaToken) {
    await storeDeltaToken(DEFAULT_PROFILE_ID, latestDeltaToken);
  }

  return c.json({ queued });
}
