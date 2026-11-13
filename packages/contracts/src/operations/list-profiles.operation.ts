import { z } from "zod";
import { defineOperation } from "../operation.js";
import { syncProfileResponseSchema } from "../responses/sync-profile.js";

export const listProfiles = defineOperation({
  id: "listProfiles",
  method: "get",
  path: "/profiles",
  summary: "List sync profiles",
  tags: ["profiles"],
  responses: { 200: z.array(syncProfileResponseSchema) },
});
