import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z as zod } from "zod";
import type { Operation } from "../operation.js";
import { operations } from "../operations/index.js";
import { openApiInfo } from "./info.js";
import { buildOpenApiDocument } from "./openapi.js";
import { renderOpenApiYaml } from "./yaml.js";

const widgetOperations: { readonly [id: string]: Operation } = {
  listWidgets: {
    id: "listWidgets",
    method: "get",
    path: "/widgets",
    summary: "List widgets",
    tags: ["widgets"],
  },
  getWidget: {
    id: "getWidget",
    method: "get",
    path: "/widgets/{widgetId}",
    summary: "Read one widget",
    tags: ["widgets"],
  },
  deleteWidget: {
    id: "deleteWidget",
    method: "delete",
    path: "/widgets/{widgetId}",
    summary: "Delete one widget",
    tags: ["widgets"],
    deprecated: true,
  },
};

const widgetInfo = { title: "Widgets", version: "1.2.3", description: "Widget surface" };

const updateWidget: Operation = {
  id: "updateWidget",
  method: "put",
  path: "/widgets/{widgetId}",
  summary: "Update one widget",
  tags: ["widgets"],
  request: {
    params: zod.object({ widgetId: zod.string().min(1) }),
    query: zod.object({ dryRun: zod.coerce.boolean().optional() }),
    body: zod.object({ name: zod.string().min(1) }).strict(),
  },
};

describe("buildOpenApiDocument", () => {
  it("gives each operation path a path item and merges methods served on the same path", () => {
    const document = buildOpenApiDocument(widgetOperations, widgetInfo);

    expect(Object.keys(document.paths)).toStrictEqual(["/widgets", "/widgets/{widgetId}"]);
    expect(document.paths["/widgets"]?.get?.operationId).toBe("listWidgets");
    expect(document.paths["/widgets/{widgetId}"]).toStrictEqual({
      get: {
        operationId: "getWidget",
        summary: "Read one widget",
        tags: ["widgets"],
      },
      delete: {
        operationId: "deleteWidget",
        summary: "Delete one widget",
        tags: ["widgets"],
        deprecated: true,
      },
    });
  });

  it("marks only the operations registered as deprecated", () => {
    const document = buildOpenApiDocument(widgetOperations, widgetInfo);

    expect(document.paths["/widgets"]?.get?.deprecated).toBeUndefined();
    expect(document.paths["/widgets/{widgetId}"]?.get?.deprecated).toBeUndefined();
    expect(document.paths["/widgets/{widgetId}"]?.delete?.deprecated).toBe(true);
  });

  it("carries the document identity it was given", () => {
    const document = buildOpenApiDocument(widgetOperations, widgetInfo);

    expect(document).toMatchObject({ openapi: "3.1.0", info: widgetInfo });
  });

  it("emits no paths for an empty registry", () => {
    const document = buildOpenApiDocument({}, widgetInfo);

    expect(document.paths).toStrictEqual({});
  });
});

describe("renderOpenApiYaml", () => {
  it("renders YAML that parses back to the document it was given", () => {
    const document = buildOpenApiDocument(widgetOperations, widgetInfo);

    expect(parse(renderOpenApiYaml(document))).toStrictEqual(document);
  });
});

describe("request schemas in the document", () => {
  it("emits a required path parameter from the params schema", () => {
    const document = buildOpenApiDocument({ updateWidget }, widgetInfo);

    expect(document.paths["/widgets/{widgetId}"]?.put?.parameters).toContainEqual({
      name: "widgetId",
      in: "path",
      required: true,
      schema: { type: "string", minLength: 1 },
    });
  });

  it("emits a query parameter that the schema leaves optional", () => {
    const document = buildOpenApiDocument({ updateWidget }, widgetInfo);

    expect(document.paths["/widgets/{widgetId}"]?.put?.parameters).toContainEqual({
      name: "dryRun",
      in: "query",
      required: false,
      schema: { type: "boolean" },
    });
  });

  it("emits the body schema and its required fields as the request body", () => {
    const document = buildOpenApiDocument({ updateWidget }, widgetInfo);

    expect(document.paths["/widgets/{widgetId}"]?.put?.requestBody).toStrictEqual({
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { name: { type: "string", minLength: 1 } },
            required: ["name"],
            additionalProperties: false,
          },
        },
      },
    });
  });

  it("emits no parameters and no request body for an operation without request schemas", () => {
    const document = buildOpenApiDocument(widgetOperations, widgetInfo);

    expect(document.paths["/widgets"]?.get?.parameters).toBeUndefined();
    expect(document.paths["/widgets"]?.get?.requestBody).toBeUndefined();
  });
});

describe("response schemas in the document", () => {
  const readWidget: Operation = {
    id: "readWidget",
    method: "get",
    path: "/widgets/{widgetId}",
    summary: "Read one widget",
    tags: ["widgets"],
    responses: {
      200: zod.object({ widgetId: zod.string().min(1) }),
      404: zod.object({ error: zod.string() }),
    },
  };

  it("emits every declared status with its schema and a description", () => {
    const document = buildOpenApiDocument({ readWidget }, widgetInfo);

    expect(document.paths["/widgets/{widgetId}"]?.get?.responses).toStrictEqual({
      "200": {
        description: "OK",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { widgetId: { type: "string", minLength: 1 } },
              required: ["widgetId"],
              additionalProperties: false,
            },
          },
        },
      },
      "404": {
        description: "Not Found",
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: { error: { type: "string" } },
              required: ["error"],
              additionalProperties: false,
            },
          },
        },
      },
    });
  });

  it("describes a response schema by what the handler sends, not by what a caller may send", () => {
    const countingWidget: Operation = {
      id: "countWidgets",
      method: "get",
      path: "/widgets",
      summary: "Count widgets",
      tags: ["widgets"],
      responses: { 200: zod.object({ count: zod.number().default(0) }) },
    };
    const document = buildOpenApiDocument({ countingWidget }, widgetInfo);
    const schema =
      document.paths["/widgets"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema;

    // A default is always applied on the way out, so the field is required in a response.
    expect(schema?.["required"]).toStrictEqual(["count"]);
  });

  it("emits no responses for an operation that declares none", () => {
    const document = buildOpenApiDocument(widgetOperations, widgetInfo);

    expect(document.paths["/widgets"]?.get?.responses).toBeUndefined();
  });
});

describe("the document generated from the registry", () => {
  it("gives every operation a response schema", () => {
    const document = buildOpenApiDocument(operations, openApiInfo);
    const withoutSchema = Object.values(document.paths).flatMap((pathItem) =>
      Object.values(pathItem).flatMap((operationObject) => {
        const responses = Object.entries(operationObject.responses ?? {});
        const described =
          responses.length > 0 && responses.every(([, response]) => response.content !== undefined);
        return described ? [] : [operationObject.operationId];
      }),
    );

    expect(withoutSchema).toStrictEqual([]);
  });
});
