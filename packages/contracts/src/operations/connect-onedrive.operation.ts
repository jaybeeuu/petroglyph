import { defineOperation } from "../operation.js";

export const connectOnedrive = defineOperation({
  id: "connectOnedrive",
  method: "post",
  path: "/onedrive/connect",
  summary: "Connect an OneDrive account",
  tags: ["onedrive"],
});
