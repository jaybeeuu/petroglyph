import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Operation } from "../operation.js";
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
