import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const packageDir = join(__dirname, "..");
const zipPath = join(packageDir, "lambda.zip");
const extractDir = join(packageDir, ".test-extract");

describe("Ingest OneDrive Lambda packaging smoke test", () => {
  beforeAll(() => {
    if (existsSync(extractDir)) {
      rmSync(extractDir, { recursive: true, force: true });
    }
    mkdirSync(extractDir, { recursive: true });

    console.log("Building Lambda package...");
    execSync("pnpm package", {
      cwd: packageDir,
      stdio: "inherit",
    });

    console.log("Extracting Lambda zip...");
    execSync(`unzip -q ${zipPath} -d ${extractDir}`, {
      cwd: packageDir,
      stdio: "inherit",
    });
  }, 60_000);

  afterAll(() => {
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
    const indexUrl = new URL(`file://${indexPath}`);
    const module = (await import(indexUrl.href)) as { handler?: unknown };

    expect(module).toHaveProperty("handler");
    expect(typeof module.handler).toBe("function");
  }, 15_000);
});
