import { GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import type { Context } from "hono";
import { docClient } from "./db.js";
import { resolveOneDriveAccessToken } from "./onedrive-middleware.js";
import { ssmClient } from "./ssm.js";

const DELTA_TOKEN_PARAMETER = "/petroglyph/onedrive/delta-token";
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

function oneDriveFolder(): string {
  return process.env["ONEDRIVE_FOLDER"] ?? "OnyxBoox";
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isParameterNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.name === "ParameterNotFound";
}

async function readDeltaToken(): Promise<string | undefined> {
  try {
    const result = await ssmClient.send(
      new GetParameterCommand({
        Name: DELTA_TOKEN_PARAMETER,
        WithDecryption: true,
      }),
    );
    return result.Parameter?.Value;
  } catch (error) {
    if (isParameterNotFoundError(error)) {
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
  const isPdf =
    mimeType === "application/pdf" ||
    filename.toLowerCase().endsWith(".pdf");

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

async function fetchDeltaPage(
  url: string,
  accessToken: string,
): Promise<GraphDeltaPage> {
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

async function storeDeltaToken(deltaToken: string): Promise<void> {
  await ssmClient.send(
    new PutParameterCommand({
      Name: DELTA_TOKEN_PARAMETER,
      Value: deltaToken,
      Type: "SecureString",
      Overwrite: true,
    }),
  );
}

export async function handleSyncRun(c: Context): Promise<Response> {
  const accessToken = await resolveOneDriveAccessToken();
  const startingDeltaToken = await readDeltaToken();

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
    await storeDeltaToken(latestDeltaToken);
  }

  return c.json({ queued });
}
