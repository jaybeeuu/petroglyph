import { z } from "zod";

/** Adapter-internal fetch job: the FileChangeEvent facts the fetcher consumes. */
export interface FetchJob {
  profileId: string;
  changeType: "created" | "updated" | "deleted";
  itemId: string;
  name: string;
  relativePath: string;
  /** Pre-download filter input only (vendor claim). */
  mimeType?: string;
  isFolder: boolean;
  /**
   * Set by the enqueuer per emission; the fetcher reuses it as the CE `id`,
   * so queue redelivery of the same job dedupes at the event log.
   */
  emissionId: string;
}

export const fetchJobSchema = z.object({
  profileId: z.string().min(1),
  changeType: z.enum(["created", "updated", "deleted"]),
  itemId: z.string().min(1),
  name: z.string().min(1),
  relativePath: z.string(),
  mimeType: z.string().min(1).optional(),
  isFolder: z.boolean(),
  emissionId: z.string().min(1),
});

export type FetchJobInput = z.input<typeof fetchJobSchema>;

export function encodeFetchJob(job: FetchJob): string {
  return JSON.stringify(fetchJobSchema.parse(job));
}

export function decodeFetchJob(body: string): FetchJob {
  const parsed = fetchJobSchema.parse(JSON.parse(body));
  return {
    profileId: parsed.profileId,
    changeType: parsed.changeType,
    itemId: parsed.itemId,
    name: parsed.name,
    relativePath: parsed.relativePath,
    isFolder: parsed.isFolder,
    emissionId: parsed.emissionId,
    ...(parsed.mimeType === undefined ? {} : { mimeType: parsed.mimeType }),
  };
}
