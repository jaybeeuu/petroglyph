import type { HttpMethod, Operation } from "../operation.js";

/** What every OpenAPI 3.1 document must carry to describe this surface. */
export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description: string;
}

/** The fields of an OpenAPI operation object that the registry supplies. */
export interface OpenApiOperationObject {
  readonly operationId: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly deprecated?: boolean;
}

/** One path, keyed by the methods served on it. */
export type OpenApiPathItem = { [Method in HttpMethod]?: OpenApiOperationObject };

/** A minimal OpenAPI 3.1 document: no schemas until slice 2 adds them. */
export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: OpenApiInfo;
  readonly paths: { readonly [path: string]: OpenApiPathItem };
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
    pathItem[operation.method] = {
      operationId: operation.id,
      summary: operation.summary,
      tags: [...operation.tags],
      ...(operation.deprecated === true ? { deprecated: true } : {}),
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
