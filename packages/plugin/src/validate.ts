export function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasStringProp<Key extends string>(
  record: { [key: string]: unknown },
  key: Key,
): record is { [key: string]: unknown } & { [key in Key]: string } {
  return typeof record[key] === "string";
}
