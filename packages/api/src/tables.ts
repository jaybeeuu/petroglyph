/**
 * The sync-profiles table's name. One definition, because three modules read it
 * and a copy that drifts names a table that does not exist. Read per call, so
 * importing this module stays free of I/O and of load-order coupling.
 */
export function syncProfilesTableName(): string {
  return process.env["SYNC_PROFILES_TABLE"] ?? "petroglyph-sync-profiles-default";
}
