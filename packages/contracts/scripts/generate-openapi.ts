import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../src/spec/openapi.js";
import { openApiInfo } from "../src/spec/info.js";
import { renderOpenApiYaml } from "../src/spec/yaml.js";
import { operations } from "../src/operations/index.js";

/** The generated spec lands at the package root, beside the registry it mirrors. */
const outputPath = fileURLToPath(new URL("../openapi.yaml", import.meta.url));

const document = buildOpenApiDocument(operations, openApiInfo);
await writeFile(outputPath, renderOpenApiYaml(document), "utf8");
process.stdout.write(`Wrote ${outputPath} (${String(Object.keys(document.paths).length)} paths)\n`);
