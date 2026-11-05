/**
 * Canonical form of a profile's source folder path: no leading or trailing
 * slash and no repeated slashes. Graph delta reports every parent path
 * relative to the drive root ("onyx/NoteAir5C/Notebooks"), never with a leading
 * slash, so a leading slash makes the walker's prefix match unsatisfiable —
 * the profile then ingests nothing while reporting a clean run.
 *
 * The whole drive is "/": the one form the delta walker treats as "no prefix"
 * and the form the OAuth upsert writes.
 */
export function normalizeSourceFolderPath(path: string): string {
  const collapsed = path.trim().replace(/\/+/g, "/");
  const stripped = collapsed.replace(/^\/+/, "").replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}
