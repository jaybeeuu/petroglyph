import { defineOperation } from "../operation.js";

export const postOnedriveLifecycle = defineOperation({
  id: "postOnedriveLifecycle",
  method: "post",
  path: "/onedrive/lifecycle",
  summary: "Receive OneDrive lifecycle notifications",
  tags: ["onedrive"],
});
