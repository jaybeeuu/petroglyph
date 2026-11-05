export { defineOperation, type HttpMethod, type Operation } from "./operation.js";
export { defineRegistry, operationKey } from "./registry.js";
export { operationList, operations, type OperationId } from "./operations/index.js";
export {
  collectRegistrySurface,
  collectServedSurface,
  compareSurface,
  type RouteTable,
  type ServedRoute,
  type SurfaceDiff,
} from "./surface.js";
export {
  buildOpenApiDocument,
  type OpenApiDocument,
  type OpenApiInfo,
  type OpenApiOperationObject,
  type OpenApiPathItem,
} from "./spec/openapi.js";
export { openApiInfo } from "./spec/info.js";
export { renderOpenApiYaml } from "./spec/yaml.js";
