import { smokeDriveItem, smokePdfBytes, SMOKE_ITEM_ID } from "./fixture.js";

/**
 * Minimal Lambda function-URL event surface. Function URLs use the same
 * payload-format-2.0 shape as API Gateway HTTP APIs; modelling only the
 * fields the stub reads keeps this package free of runtime types.
 */
export interface FunctionUrlEvent {
  rawPath?: string;
  rawQueryString?: string;
  headers?: { [key: string]: string | undefined };
  requestContext?: {
    domainName?: string;
    http?: { method?: string };
  };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers?: { [key: string]: string };
  body?: string;
  isBase64Encoded?: boolean;
}

const JSON_HEADERS = { "content-type": "application/json" };

function baseUrl(event: FunctionUrlEvent): string {
  const host = event.requestContext?.domainName ?? event.headers?.["host"] ?? "localhost";
  return `https://${host}`;
}

function method(event: FunctionUrlEvent): string {
  return event.requestContext?.http?.method ?? "GET";
}

function query(event: FunctionUrlEvent): URLSearchParams {
  return new URLSearchParams(event.rawQueryString ?? "");
}

function notFound(): FunctionUrlResult {
  return { statusCode: 404, headers: JSON_HEADERS, body: JSON.stringify({ error: "not found" }) };
}

function json(statusCode: number, body: unknown): FunctionUrlResult {
  return { statusCode, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

let subscriptionCounter = 0;
let deltaVersion = 0;

function route(event: FunctionUrlEvent): FunctionUrlResult {
  const path = event.rawPath ?? "/";
  const verb = method(event);

  if (path === "/health" && verb === "GET") {
    return json(200, { status: "ok" });
  }

  if (path === "/me/drive/root/delta" && verb === "GET") {
    // Function URLs reject a literal "$" in the query string, so the
    // deltaLink percent-encodes it; URLSearchParams decodes it back to
    // "$deltatoken" when the walk follows it.
    const deltaLink = `${baseUrl(event)}/me/drive/root/delta?%24deltatoken=smoke`;
    // First call enumerates the fixture item; a walk that follows the
    // deltaLink sees no further changes so the change token stabilises. The
    // eTag is fresh per enumeration so a repeat smoke run is a new revision —
    // otherwise the deterministic emission id would be deduped by the
    // event log and the forwarder's FIFO within its five-minute window.
    deltaVersion += 1;
    const value = query(event).has("$deltatoken")
      ? []
      : [smokeDriveItem(`smoke-etag-${Date.now().toString()}-${deltaVersion.toString()}`)];
    return json(200, { value, "@odata.deltaLink": deltaLink });
  }

  if (path.startsWith("/me/drive/items/") && path.endsWith("/content") && verb === "GET") {
    const itemId = decodeURIComponent(path.slice("/me/drive/items/".length, -"/content".length));
    if (itemId !== SMOKE_ITEM_ID) {
      return notFound();
    }
    return {
      statusCode: 200,
      headers: { "content-type": "application/pdf" },
      body: Buffer.from(smokePdfBytes()).toString("base64"),
      isBase64Encoded: true,
    };
  }

  if (path === "/subscriptions" && verb === "POST") {
    subscriptionCounter += 1;
    const id = `smoke-subscription-${subscriptionCounter}`;
    return json(201, {
      id,
      resource: "/me/drive/root",
      expirationDateTime: "2099-01-01T00:00:00.000Z",
      notificationUrl: "https://example.test/webhooks/onedrive",
    });
  }

  if (path.startsWith("/subscriptions/")) {
    const id = decodeURIComponent(path.slice("/subscriptions/".length));
    if (verb === "GET") {
      return json(200, { id, expirationDateTime: "2099-01-01T00:00:00.000Z" });
    }
    if (verb === "PATCH") {
      return json(200, { id, expirationDateTime: "2099-01-01T00:00:00.000Z" });
    }
    if (verb === "DELETE") {
      return { statusCode: 204 };
    }
  }

  return notFound();
}

/**
 * The QA Graph stub: only what the deployed smoke journey needs — a drive
 * delta page + item content, plus subscription lifecycle responses so a
 * manually connected QA account does not fail on Graph. Deterministic: no
 * clock or random source in the smoke path (subscription ids count up).
 */
export function createGraphStubHandler(): (event: FunctionUrlEvent) => Promise<FunctionUrlResult> {
  return (event) => Promise.resolve(route(event));
}

export const handler = createGraphStubHandler();
