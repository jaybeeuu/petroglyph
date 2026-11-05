import { stringify } from "yaml";
import type { OpenApiDocument } from "./openapi.js";

/** Renders the document as OpenAPI YAML text, unwrapped so diffs stay readable. */
export function renderOpenApiYaml(document: OpenApiDocument): string {
  return stringify(document, { lineWidth: 0 });
}
