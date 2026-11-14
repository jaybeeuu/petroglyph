import { z } from "zod";
import { defineOperation } from "../operation.js";

export const getHealth = defineOperation({
  id: "getHealth",
  method: "get",
  path: "/health",
  summary: "Report service health",
  tags: ["health"],
  responses: { 200: z.object({ status: z.literal("ok") }) },
});
