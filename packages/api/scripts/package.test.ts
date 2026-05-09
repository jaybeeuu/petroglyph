import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const apiDir = join(__dirname, "..");
const zipPath = join(apiDir, "lambda.zip");
const extractDir = join(apiDir, ".test-extract");

describe("Lambda packaging smoke test", () => {
  beforeAll(() => {
    // Clean up any previous test extraction
    if (existsSync(extractDir)) {
      rmSync(extractDir, { recursive: true, force: true });
    }
    mkdirSync(extractDir, { recursive: true });

    // Build the package
    console.log("Building Lambda package...");
    execSync("pnpm package", {
      cwd: apiDir,
      stdio: "inherit",
    });

    // Extract the zip
    console.log("Extracting Lambda zip...");
    execSync(`unzip -q ${zipPath} -d ${extractDir}`, {
      cwd: apiDir,
      stdio: "inherit",
    });
  }, 30_000);

  afterAll(() => {
    // Clean up test extraction
    if (existsSync(extractDir)) {
      rmSync(extractDir, { recursive: true, force: true });
    }
  });

  it("zip file exists", () => {
    expect(existsSync(zipPath)).toBe(true);
  });

  it("contains dist/index.js", () => {
    const indexPath = join(extractDir, "dist", "index.js");
    expect(existsSync(indexPath)).toBe(true);
  });

  it("contains package.json", () => {
    const pkgPath = join(extractDir, "package.json");
    expect(existsSync(pkgPath)).toBe(true);
  });

  it("dist/index.js can be loaded by Node and exports handler", async () => {
    const indexPath = join(extractDir, "dist", "index.js");

    // Dynamically import the bundled index.js
    // Use file:// URL for cross-platform compatibility
    const indexUrl = new URL(`file://${indexPath}`);
    const module = (await import(indexUrl.href)) as { handler?: unknown };

    expect(module).toHaveProperty("handler");
    expect(typeof module.handler).toBe("function");
  }, 15_000);

  it("handler export matches terraform config (dist/index.handler)", async () => {
    // This test documents that the Terraform config expects dist/index.handler
    // which means the zip must have dist/index.js with a named export "handler"
    const indexPath = join(extractDir, "dist", "index.js");
    const indexUrl = new URL(`file://${indexPath}`);
    const module = (await import(indexUrl.href)) as { handler?: unknown };

    // The Lambda handler path "dist/index.handler" means:
    // - file: dist/index.js (relative to zip root)
    // - export: "handler"
    expect(module.handler).toBeDefined();
    expect(typeof module.handler).toBe("function");
  });
});
