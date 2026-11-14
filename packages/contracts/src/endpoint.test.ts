import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import {
  defineEndpoint,
  toHonoPath,
  type EndpointHandler,
  type EndpointOptions,
} from "./endpoint.js";
import { defineOperation, type Operation } from "./operation.js";

const updateWidget = defineOperation({
  id: "updateWidget",
  method: "put",
  path: "/widgets/{widgetId}",
  summary: "Update a widget",
  tags: ["widgets"],
  request: {
    params: z.object({ widgetId: z.coerce.number().int() }),
    query: z.object({ limit: z.coerce.number().int().positive().max(100).default(25) }),
    body: z.object({ name: z.string().min(1) }),
    rejection: { error: "Invalid widget request", includeIssues: true },
  },
});

const listWidgets = defineOperation({
  id: "listWidgets",
  method: "get",
  path: "/widgets",
  summary: "List widgets",
  tags: ["widgets"],
});

type WidgetEnv = { Variables: { userId: string } };

function createWidgetApp<OperationDefinition extends Operation>(
  operation: OperationDefinition,
  handler: EndpointHandler<OperationDefinition, WidgetEnv>,
  options?: EndpointOptions,
): Hono<WidgetEnv> {
  const app = new Hono<WidgetEnv>();
  const [first, ...rest] = defineEndpoint(operation, handler, options);
  if (first === undefined) {
    throw new Error("defineEndpoint returned no handlers");
  }

  app.on(operation.method.toUpperCase(), toHonoPath(operation.path), first, ...rest);

  return app;
}

async function updateRequest(app: Hono<WidgetEnv>, path: string, body: string): Promise<Response> {
  const response = await app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return response;
}

describe("defineEndpoint", () => {
  it("hands the handler the parsed params, query and body", async () => {
    const app = createWidgetApp(updateWidget, (input, c) =>
      c.json({ params: input.params, query: input.query, body: input.body }),
    );

    const response = await updateRequest(app, "/widgets/7?limit=5", JSON.stringify({ name: "n" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({
      params: { widgetId: 7 },
      query: { limit: 5 },
      body: { name: "n" },
    });
  });

  it("answers the operation's rejection body when the body violates its schema", async () => {
    let handlerRan = false;
    const app = createWidgetApp(updateWidget, (_input, c) => {
      handlerRan = true;
      return c.json({ updated: true });
    });

    const response = await updateRequest(app, "/widgets/7", JSON.stringify({ name: "" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid widget request" });
    expect(handlerRan).toBe(false);
  });

  it("answers the operation's rejection body when a query value violates its schema", async () => {
    const app = createWidgetApp(updateWidget, (_input, c) => c.json({ updated: true }));

    const response = await updateRequest(app, "/widgets/7?limit=0", JSON.stringify({ name: "n" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid widget request" });
  });

  it("hands the handler a body the request sends without a JSON content type", async () => {
    const app = createWidgetApp(updateWidget, (input, c) => c.json({ body: input.body }));

    const response = await app.request("/widgets/7", {
      method: "PUT",
      body: JSON.stringify({ name: "n" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ body: { name: "n" } });
  });

  it("answers the operation's rejection body when the body is not JSON", async () => {
    let handlerRan = false;
    const app = createWidgetApp(updateWidget, (_input, c) => {
      handlerRan = true;
      return c.json({ updated: true });
    });

    const response = await app.request("/widgets/7", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: '{"name": ',
    });

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: "Invalid widget request" });
    expect(handlerRan).toBe(false);
  });

  it("answers the operation's rejection body when the body is absent", async () => {
    const app = createWidgetApp(updateWidget, (_input, c) => c.json({ updated: true }));

    const response = await app.request("/widgets/7", { method: "PUT" });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid widget request" });
  });

  it("answers the operation's rejection body when a path parameter violates its schema", async () => {
    const app = createWidgetApp(updateWidget, (_input, c) => c.json({ updated: true }));

    const response = await updateRequest(app, "/widgets/seven", JSON.stringify({ name: "n" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid widget request" });
  });

  it("hands every target undefined to an operation that declares no request", async () => {
    const app = createWidgetApp(listWidgets, (input, c) => c.json(input));

    const response = await app.request("/widgets");

    // Every target is undefined, so none reaches the JSON body.
    expect(await response.json()).toStrictEqual({});
  });

  it("answers a default rejection body when the operation names none", async () => {
    const createWidget = defineOperation({
      id: "createWidget",
      method: "post",
      path: "/widgets",
      summary: "Create a widget",
      tags: ["widgets"],
      request: { body: z.object({ name: z.string().min(1) }) },
    });
    const app = createWidgetApp(createWidget, (_input, c) => c.json({ created: true }, 201));

    const response = await app.request("/widgets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({ error: "Invalid request" });
  });
});

const readWidget = defineOperation({
  id: "readWidget",
  method: "get",
  path: "/widgets",
  summary: "Read a widget",
  tags: ["widgets"],
  responses: {
    200: z.object({ status: z.literal("ok") }),
    404: z.object({ error: z.string() }),
  },
});

/** A body the handler writes but the operation's schema forbids. */
const DRIFTED_WIDGET = { status: "broken" } as unknown as { status: "ok" };

/** What `report` mode answers in place of a response that violates its schema. */
const mismatchBodySchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(z.object({ path: z.array(z.string()) })),
  }),
});

describe("response validation", () => {
  it("sends a body that matches its schema", async () => {
    const app = createWidgetApp(readWidget, (_input, c) => c.json({ status: "ok" }));
    const response = await app.request("/widgets");
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: "ok" });
  });

  it("reports a body that violates its schema instead of sending it", async () => {
    const app = createWidgetApp(readWidget, (_input, c) => c.json(DRIFTED_WIDGET));
    const response = await app.request("/widgets");
    const mismatch = mismatchBodySchema.parse(await response.json());

    expect(response.status).toBe(500);
    expect(mismatch.error.code).toBe("response_contract_mismatch");
    expect(mismatch.error.message).toContain("readWidget");
    expect(mismatch.error.details[0]?.path).toStrictEqual(["status"]);
  });

  it("sends the drifted body unchanged in production, and logs the mismatch", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const app = createWidgetApp(readWidget, (_input, c) => c.json(DRIFTED_WIDGET), {
        responseValidation: "log",
      });
      const response = await app.request("/widgets");
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({ status: "broken" });
      expect(logged).toHaveBeenCalledWith(expect.any(String), {
        operationId: "readWidget",
        status: 200,
        issues: [expect.objectContaining({ path: ["status"] })],
      });
    } finally {
      logged.mockRestore();
    }
  });

  it("leaves a status the operation declares no schema for alone", async () => {
    const listWidgetsOnly = defineOperation({
      id: "listWidgetsOnly",
      method: "get",
      path: "/widgets",
      summary: "List widgets",
      tags: ["widgets"],
      responses: { 200: z.object({ widgets: z.array(z.string()) }) },
    });
    const app = createWidgetApp(listWidgetsOnly, (_input, c) =>
      c.json({ error: "Widget not found" }, 404),
    );
    const response = await app.request("/widgets");
    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({ error: "Widget not found" });
  });
});

describe("toHonoPath", () => {
  it("spells an OpenAPI path parameter the way Hono registers it", () => {
    expect(toHonoPath("/profiles/{id}")).toBe("/profiles/:id");
  });

  it("leaves a path without parameters unchanged", () => {
    expect(toHonoPath("/files/changes")).toBe("/files/changes");
  });
});
