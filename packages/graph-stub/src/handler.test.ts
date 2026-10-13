import { describe, expect, it } from "vitest";
import { createGraphStubHandler, type FunctionUrlEvent } from "./handler.js";
import {
  SMOKE_ITEM_ID,
  SMOKE_ITEM_PARENT_PATH,
  SMOKE_PDF_MARKER,
  smokePdfBytes,
} from "./fixture.js";

function createEvent(
  method: string,
  rawPath: string,
  overrides: Partial<FunctionUrlEvent> = {},
): FunctionUrlEvent {
  return {
    rawPath,
    rawQueryString: "",
    requestContext: { domainName: "stub.example.test", http: { method } },
    ...overrides,
  };
}

function decodeBody(result: { body?: string; isBase64Encoded?: boolean }): string {
  const body = result.body ?? "";
  return result.isBase64Encoded === true ? Buffer.from(body, "base64").toString("utf8") : body;
}

describe("createGraphStubHandler", () => {
  it("enumerates the smoke file on the first delta call", async () => {
    const handler = createGraphStubHandler();

    const result = await handler(createEvent("GET", "/me/drive/root/delta"));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(decodeBody(result)) as {
      value: { id: string; name: string }[];
      "@odata.deltaLink": string;
    };
    expect(body.value).toMatchObject([
      { id: SMOKE_ITEM_ID, name: "smoke.pdf", parentReference: { path: SMOKE_ITEM_PARENT_PATH } },
    ]);
    expect(body["@odata.deltaLink"]).toContain("$deltatoken=smoke");
  });

  it("returns no changes when the walk follows its deltaLink", async () => {
    const handler = createGraphStubHandler();

    const result = await handler(
      createEvent("GET", "/me/drive/root/delta", { rawQueryString: "$deltatoken=smoke" }),
    );

    const body = JSON.parse(decodeBody(result)) as { value: unknown[] };
    expect(body.value).toEqual([]);
  });

  it("serves the fixture PDF bytes for the smoke item's content", async () => {
    const handler = createGraphStubHandler();

    const result = await handler(createEvent("GET", `/me/drive/items/${SMOKE_ITEM_ID}/content`));

    expect(result.statusCode).toBe(200);
    expect(result.isBase64Encoded).toBe(true);
    const bytes = new Uint8Array(Buffer.from(result.body ?? "", "base64"));
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(decodeBody(result)).toContain(SMOKE_PDF_MARKER);
    expect(bytes).toEqual(smokePdfBytes());
  });

  it("returns 404 for content the smoke journey does not stage", async () => {
    const handler = createGraphStubHandler();

    const result = await handler(createEvent("GET", "/me/drive/items/other-item/content"));

    expect(result.statusCode).toBe(404);
  });

  it("accepts a subscription, then serves, refreshes and removes it", async () => {
    const handler = createGraphStubHandler();

    const created = await handler(createEvent("POST", "/subscriptions"));
    expect(created.statusCode).toBe(201);
    const { id } = JSON.parse(decodeBody(created)) as { id: string };

    const fetched = await handler(createEvent("GET", `/subscriptions/${id}`));
    expect(fetched.statusCode).toBe(200);
    expect(JSON.parse(decodeBody(fetched))).toMatchObject({ id });

    const refreshed = await handler(createEvent("PATCH", `/subscriptions/${id}`));
    expect(refreshed.statusCode).toBe(200);

    const removed = await handler(createEvent("DELETE", `/subscriptions/${id}`));
    expect(removed.statusCode).toBe(204);
  });

  it("reports health for readiness probes", async () => {
    const handler = createGraphStubHandler();

    const result = await handler(createEvent("GET", "/health"));

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body ?? "")).toEqual({ status: "ok" });
  });
});
