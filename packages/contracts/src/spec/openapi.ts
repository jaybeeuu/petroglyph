import { z } from "zod";
import type { HttpMethod, Operation, RequestSchemas } from "../operation.js";

/** What every OpenAPI 3.1 document must carry to describe this surface. */
export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description: string;
}

/** A JSON Schema as zod emits it for one operation schema. */
export type JsonSchema = { readonly [keyword: string]: unknown };

/** One path or query parameter, as declared by an operation's request schema. */
export interface OpenApiParameter {
  readonly name: string;
  readonly in: "path" | "query";
  readonly required: boolean;
  readonly schema: JsonSchema;
}

/** A body an operation reads, described by the operation's body schema. */
export interface OpenApiRequestBody {
  readonly required: true;
  readonly content: { readonly "application/json": { readonly schema: JsonSchema } };
}

/** The fields of an OpenAPI operation object that the registry supplies. */
export interface OpenApiOperationObject {
  readonly operationId: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly deprecated?: boolean;
  readonly parameters?: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
}

/** One path, keyed by the methods served on it. */
export type OpenApiPathItem = { [Method in HttpMethod]?: OpenApiOperationObject };

/** An OpenAPI 3.1 document generated from the operation registry. */
export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: OpenApiInfo;
  readonly paths: { readonly [path: string]: OpenApiPathItem };
}

/**
 * One zod schema as JSON Schema. `io: "input"` because a request schema
 * describes what a client may send, which is the input side of a transform or a
 * default. The `$schema` dialect marker is dropped: OpenAPI 3.1 fixes the
 * dialect for the whole document, so repeating it per schema is noise.
 */
function toJsonSchema(schema: z.ZodType): JsonSchema {
  const document = z.toJSONSchema(schema, { io: "input", target: "draft-2020-12" });
  return Object.fromEntries(Object.entries(document).filter(([keyword]) => keyword !== "$schema"));
}

/** The parameters one request target declares, in the location OpenAPI wants. */
function parametersFor(
  schema: z.ZodType,
  location: OpenApiParameter["in"],
): readonly OpenApiParameter[] {
  const jsonSchema = toJsonSchema(schema);
  const properties = (jsonSchema["properties"] ?? {}) as { readonly [name: string]: JsonSchema };
  const required = new Set((jsonSchema["required"] ?? []) as readonly string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    // OpenAPI requires every path parameter to be present, by definition.
    required: location === "path" || required.has(name),
    schema: property,
  }));
}

/** Every parameter and body the operation's request schemas declare. */
function requestFields(request: RequestSchemas | undefined): {
  readonly parameters: readonly OpenApiParameter[];
  readonly requestBody?: OpenApiRequestBody;
} {
  const parameters = [
    ...(request?.params === undefined ? [] : parametersFor(request.params, "path")),
    ...(request?.query === undefined ? [] : parametersFor(request.query, "query")),
  ];
  const requestBody =
    request?.body === undefined
      ? undefined
      : {
          required: true as const,
          content: { "application/json": { schema: toJsonSchema(request.body) } },
        };
  return { parameters, ...(requestBody === undefined ? {} : { requestBody }) };
}

/**
 * Turns the operation registry into an OpenAPI 3.1 document. Paths come out
 * sorted so the generated file only changes when an operation changes.
 */
export function buildOpenApiDocument(
  operations: { readonly [id: string]: Operation },
  info: OpenApiInfo,
): OpenApiDocument {
  const paths = new Map<string, OpenApiPathItem>();

  for (const operation of Object.values(operations)) {
    const pathItem = paths.get(operation.path) ?? {};
    const { parameters, requestBody } = requestFields(operation.request);
    pathItem[operation.method] = {
      operationId: operation.id,
      summary: operation.summary,
      tags: [...operation.tags],
      ...(operation.deprecated === true ? { deprecated: true } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(requestBody === undefined ? {} : { requestBody }),
    };
    paths.set(operation.path, pathItem);
  }

  const sortedPaths: { [path: string]: OpenApiPathItem } = {};
  for (const path of [...paths.keys()].sort()) {
    const pathItem = paths.get(path);
    if (pathItem !== undefined) {
      sortedPaths[path] = pathItem;
    }
  }

  return { openapi: "3.1.0", info, paths: sortedPaths };
}
