import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/make-zip.mjs");
const placeholder =
  'exports.handler = async () => ({ statusCode: 200, body: \'{"status":"placeholder"}\' });\n';

function createArchive(): { archive: Buffer; tempDir: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "make-zip-"));
  const sourcePath = join(tempDir, "index.js");
  const archivePath = join(tempDir, "lambda.zip");
  writeFileSync(sourcePath, placeholder);
  execFileSync(process.execPath, [scriptPath, sourcePath, archivePath]);
  return { archive: readFileSync(archivePath), tempDir };
}

describe("make-zip.mjs", () => {
  it("creates a zip containing the source file", async () => {
    const { archive, tempDir } = createArchive();
    try {
      const zip = await JSZip.loadAsync(archive);
      const entry = zip.file("index.js");
      if (entry === null) {
        throw new Error("expected the archive to contain index.js");
      }
      expect(await entry.async("string")).toBe(placeholder);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("produces identical bytes across runs", () => {
    const { archive, tempDir } = createArchive();
    try {
      const second = createArchive();
      try {
        expect(archive).toEqual(second.archive);
      } finally {
        rmSync(second.tempDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
