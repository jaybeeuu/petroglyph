#!/usr/bin/env node
// Create a minimal ZIP archive containing a single file.
//
// Used by bootstrap.sh to produce the placeholder Lambda zip. jszip
// supplies the archive writer; the file timestamp is pinned so identical
// input always produces identical output.
//
// Usage:
//   node make-zip.mjs <source-file> <archive-path>

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import JSZip from "jszip";

// jszip embeds the file timestamp in the archive, so a fixed value keeps
// the output byte-deterministic across runs.
const FIXED_TIMESTAMP = new Date("1980-01-01T00:00:00Z");

async function zipFile(sourcePath, archivePath) {
  const zip = new JSZip();
  zip.file(basename(sourcePath), readFileSync(sourcePath), { date: FIXED_TIMESTAMP });
  const archive = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(archivePath, archive);
}

if (process.argv.length !== 4) {
  process.stderr.write("usage: node make-zip.mjs <source-file> <archive-path>\n");
  process.exit(1);
}

await zipFile(process.argv[2], process.argv[3]);
