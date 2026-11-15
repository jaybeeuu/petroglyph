export {
  stagedRecordSchema,
  DynamoDBStagedIndexStore,
  DynamoDBStagedChangeLog,
} from "@petroglyph/staging-contracts";
export type {
  StagedRecord,
  StagedIndexStore,
  StagedChange,
  StagedChangeLog,
} from "@petroglyph/staging-contracts";
export { applyStaged, applyDeleted } from "./index-apply.js";
export type { ApplyStagedOptions, ApplyDeletedOptions } from "./index-apply.js";
export { forwardStreamRecords } from "./forwarder.js";
export type { ForwardDependencies, ForwardResult } from "./forwarder.js";
export { createDdbStreamEventSource } from "./ddb-stream-event-source.js";
