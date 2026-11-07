import type { Operation } from "./operation.js";

/**
 * Types the operation registry. The mapped constraint holds each entry's `id`
 * to its own key, so the registry cannot carry a key whose value disagrees.
 * `Operations[Id]` keeps every literal, so `OperationId` stays a union of the
 * registered ids and never widens to `string`.
 */
export function defineRegistry<
  const Operations extends {
    readonly [Id in keyof Operations]: Operation & { readonly id: Id };
  },
>(operations: Operations): Operations {
  return operations;
}

/** `method` + `path` of one operation, uppercased method, OpenAPI path form. */
export function operationKey(operation: Operation): string {
  return `${operation.method.toUpperCase()} ${operation.path}`;
}
