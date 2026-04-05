export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasStringProp<Key extends string>(
  record: Record<string, unknown>,
  key: Key,
): record is Record<string, unknown> & Record<Key, string> {
  return typeof record[key] === "string";
}
