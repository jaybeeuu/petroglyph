/**
 * Probe: settle the OneDrive Graph delta wire contract.
 *
 * Question (petroglyph-j1gn.23 scope item 3): does `/me/drive/root/delta`
 * return `parentReference.path`? The Graph docs say it does NOT. If that holds,
 * the adapter's relativePath derivation — which reads `parentReference.path` —
 * cannot work and must be redesigned (per-item GET / ancestor resolution /
 * local path map).
 *
 * This script is READ-ONLY against AWS and Graph:
 *   1. discovers the `petroglyph-token-vaults-*` table,
 *   2. reads the OneDrive refresh token from the vault,
 *   3. reads the Microsoft client id/secret from SSM,
 *   4. mints an access token, then
 *   5. calls the delta endpoint twice — once with the app's exact `$select`,
 *      once with the default projection — and prints the observed
 *      `parentReference` shape per item plus a verdict.
 *
 * The second call matters: `$select` projection is a prime suspect for
 * stripping `path`, so comparing them separates "delta never has path" from
 * "our $select strips path".
 *
 * Tokens and secrets are never printed.
 *
 * Usage (either):
 *   # 1. Direct token — no AWS needed (paste a token from Graph Explorer):
 *   GRAPH_ACCESS_TOKEN=... pnpm --filter @petroglyph/api exec tsx scripts/probe-graph-delta.ts
 *
 *   # 2. From the DynamoDB token vault (needs a live SSO session):
 *   aws sso login --profile petroglyph-admin
 *   AWS_PROFILE=petroglyph-admin pnpm --filter @petroglyph/api exec tsx scripts/probe-graph-delta.ts
 */

import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GetParametersCommand } from "@aws-sdk/client-ssm";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "../src/db.js";
import { ssmClient } from "../src/ssm.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const DELTA_URL = `${GRAPH_BASE}/me/drive/root/delta`;
const APP_SELECT = "id,name,parentReference,file,folder,deleted";
const MAX_PAGES = Number(process.env["PROBE_MAX_PAGES"] ?? "3");

interface UnknownObject {
  readonly [key: string]: unknown;
}

function isRecord(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function findVaultTable(ddb: DynamoDBClient): Promise<string> {
  const override = process.env["TOKEN_VAULT_TABLE"];
  if (override) {
    return override;
  }
  const { TableNames = [] } = await ddb.send(new ListTablesCommand({}));
  const matches = TableNames.filter((name) => name.startsWith("petroglyph-token-vaults-"));
  const [match] = matches;
  if (match === undefined) {
    throw new Error(
      `No petroglyph-token-vaults-* table found in ${process.env["AWS_REGION"] ?? "the default region"}.`,
    );
  }
  if (matches.length > 1) {
    console.warn(`Multiple token vaults found, using the first: ${matches.join(", ")}`);
  }
  return match;
}

async function readVaultRecord(tableName: string): Promise<UnknownObject> {
  const { Items = [] } = await docClient.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: "provider = :provider",
      ExpressionAttributeValues: { ":provider": "onedrive" },
    }),
  );

  // Prefer a healthy connection; otherwise the most recently updated.
  const sorted = [...Items].sort((a, b) => {
    const aHealthy = a["reconnectRequired"] === true ? 1 : 0;
    const bHealthy = b["reconnectRequired"] === true ? 1 : 0;
    if (aHealthy !== bHealthy) return aHealthy - bHealthy;
    return String(b["updatedAt"] ?? "").localeCompare(String(a["updatedAt"] ?? ""));
  });
  const [record] = sorted;
  if (record === undefined) {
    throw new Error(
      `No provider=onedrive record in ${tableName}. Connect OneDrive first (pnpm --filter @petroglyph/api local-onedrive-flow).`,
    );
  }
  return record;
}

async function readMicrosoftCredentials(): Promise<{ clientId: string; clientSecret: string }> {
  const names = ["/petroglyph/onedrive/client-id", "/petroglyph/onedrive/client-secret"];
  const { Parameters = [] } = await ssmClient.send(
    new GetParametersCommand({ Names: names, WithDecryption: true }),
  );
  const byName = new Map(Parameters.map((p) => [p.Name, p.Value]));
  const clientId = byName.get(names[0]) ?? process.env["MICROSOFT_CLIENT_ID"];
  const clientSecret = byName.get(names[1]) ?? process.env["MICROSOFT_CLIENT_SECRET"];
  if (!clientId || !clientSecret) {
    throw new Error(`Could not resolve Microsoft client id/secret from SSM (${names.join(", ")}).`);
  }
  return { clientId, clientSecret };
}

async function mintAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: "files.readwrite offline_access",
  });
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const raw: unknown = await response.json();
  if (!response.ok) {
    const error = isRecord(raw) ? stringOrUndefined(raw["error"]) : undefined;
    throw new Error(
      `Token endpoint returned ${response.status}${error ? ` (${error})` : ""}. The stored refresh token may be stale — reconnect OneDrive.`,
    );
  }
  const accessToken = isRecord(raw) ? stringOrUndefined(raw["access_token"]) : undefined;
  if (!accessToken) {
    throw new Error("Token endpoint response had no access_token.");
  }
  return accessToken;
}

async function fetchDeltaItems(url: string, accessToken: string): Promise<UnknownObject[]> {
  const items: UnknownObject[] = [];
  let next: string | undefined = url;
  let pages = 0;
  while (next && pages < MAX_PAGES) {
    const response = await fetch(next, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) {
      throw new Error(`Graph ${response.status} for ${next}: ${await response.text()}`);
    }
    const raw: unknown = await response.json();
    if (!isRecord(raw) || !Array.isArray(raw["value"])) {
      throw new Error("Graph delta response had no value array.");
    }
    for (const item of raw["value"]) {
      if (isRecord(item)) items.push(item);
    }
    next = stringOrUndefined(raw["@odata.nextLink"]);
    pages += 1;
  }
  return items;
}

interface Shape {
  withPath: number;
  withoutPath: number;
  noParent: number;
  parentHasId: number;
}

function summarize(label: string, items: UnknownObject[]): Shape {
  const shape: Shape = { withPath: 0, withoutPath: 0, noParent: 0, parentHasId: 0 };
  for (const item of items) {
    const parent = item["parentReference"];
    if (!isRecord(parent)) {
      shape.noParent += 1;
      continue;
    }
    if (typeof parent["path"] === "string") shape.withPath += 1;
    else shape.withoutPath += 1;
    if (typeof parent["id"] === "string") shape.parentHasId += 1;
  }

  console.log(`\n=== ${label} ===`);
  console.log(
    `items=${items.length} parentWithPath=${shape.withPath} parentWithoutPath=${shape.withoutPath} noParentReference=${shape.noParent} parentHasId=${shape.parentHasId}`,
  );
  console.log("first items' parentReference:");
  console.log(
    JSON.stringify(
      items.slice(0, 4).map((item) => ({
        id: item["id"],
        name: item["name"],
        parentReference: item["parentReference"],
      })),
      null,
      2,
    ),
  );

  const anomalies = items.filter((item) => {
    const parent = item["parentReference"];
    return !isRecord(parent) || typeof parent["path"] !== "string";
  });
  if (anomalies.length > 0) {
    console.log(`items WITHOUT parentReference.path (${anomalies.length}):`);
    console.log(
      JSON.stringify(
        anomalies.slice(0, 10).map((item) => ({
          id: item["id"],
          name: item["name"],
          deleted: item["deleted"] !== undefined,
          folder: item["folder"] !== undefined,
          parentReference: item["parentReference"],
        })),
        null,
        2,
      ),
    );
  }
  return shape;
}

async function probeItemGet(itemId: string, accessToken: string): Promise<void> {
  const url = `${GRAPH_BASE}/me/drive/items/${itemId}?$select=id,name,parentReference`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) {
    console.log(`(follow-up item GET returned ${response.status})`);
    return;
  }
  const raw: unknown = await response.json();
  console.log(
    "follow-up GET parentReference:",
    JSON.stringify(isRecord(raw) ? raw["parentReference"] : raw),
  );
}

async function resolveAccessToken(): Promise<string> {
  const direct = process.env["GRAPH_ACCESS_TOKEN"];
  if (direct) {
    console.log("Using GRAPH_ACCESS_TOKEN from env — skipping AWS.\n");
    return direct;
  }

  const ddb = new DynamoDBClient({});
  const tableName = await findVaultTable(ddb);
  console.log(`Token vault: ${tableName}`);

  const record = await readVaultRecord(tableName);
  const refreshToken = stringOrUndefined(record["refreshToken"]);
  if (!refreshToken) {
    throw new Error("Vault record has no refreshToken.");
  }
  console.log(
    `Vault record: userId=${String(record["userId"]).slice(0, 4)}… provider=${String(record["provider"])} reconnectRequired=${String(record["reconnectRequired"])} updatedAt=${String(record["updatedAt"])}`,
  );

  const { clientId, clientSecret } = await readMicrosoftCredentials();
  const accessToken = await mintAccessToken(clientId, clientSecret, refreshToken);
  console.log("Access token minted.\n");
  return accessToken;
}

async function main(): Promise<void> {
  const accessToken = await resolveAccessToken();

  const withSelect = await fetchDeltaItems(`${DELTA_URL}?$select=${APP_SELECT}`, accessToken);
  const withSelectShape = summarize("app $select", withSelect);

  const withoutSelect = await fetchDeltaItems(DELTA_URL, accessToken);
  const withoutSelectShape = summarize("default projection (no $select)", withoutSelect);

  const firstWithId = withSelect.find((item) => typeof item["id"] === "string");
  if (firstWithId) {
    await probeItemGet(String(firstWithId["id"]), accessToken);
  }

  console.log("\n=== VERDICT ===");
  const total = withSelect.length;
  if (withSelectShape.withPath === 0 && withSelectShape.withoutPath > 0) {
    console.log(
      "Reading (a): delta returns parentReference WITHOUT path. The Graph docs hold; the adapter cannot derive relativePath from the delta payload and scope item 3 must be resolved (per-item GET / ancestor resolution / local path map).",
    );
  } else if (withSelectShape.withPath > 0) {
    console.log(
      `Reading (b): delta returns parentReference WITH path for ${withSelectShape.withPath}/${total} items. The adapter's current path-based derivation works.`,
    );
    if (withSelectShape.withoutPath > 0) {
      console.log(
        `  ${withSelectShape.withoutPath} item(s) have no path — inspect the anomaly list above; root-like items legitimately have none, which is the "path unknown vs drive root" distinction the fix already handles.`,
      );
    }
  } else {
    console.log(
      "Reading (b'): delta omits parentReference entirely. relativePath cannot come from the delta payload; scope item 3 must be resolved.",
    );
  }

  if (
    withSelectShape.withPath !== withoutSelectShape.withPath ||
    withSelectShape.withoutPath !== withoutSelectShape.withoutPath
  ) {
    console.log(
      "NOTE: the app's $select and the default projection differ — $select projection affects parentReference.path; consider dropping parentReference from $select.",
    );
  } else {
    console.log(
      "NOTE: app $select and default projection returned identical shapes — $select is NOT the cause.",
    );
  }
}

await main();
