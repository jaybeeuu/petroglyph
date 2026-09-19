import { regenerateCatalogue } from "./generate.js";

const report = await regenerateCatalogue();

console.log(
  `event catalogue: wrote ${report.written.length} schema artifact(s), ` +
    `removed ${report.removed.length} orphaned artifact(s).`,
);
