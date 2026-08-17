import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("plugin build artifact", () => {
  it("assembles the Obsidian plugin folder (main.js, manifest.json, styles.css) in dist", () => {
    execFileSync(process.execPath, ["esbuild.config.mjs"], {
      cwd: packageRoot,
      stdio: "pipe",
    });

    const dist = join(packageRoot, "dist");
    expect(existsSync(join(dist, "main.js"))).toBe(true);
    expect(existsSync(join(dist, "manifest.json"))).toBe(true);
    expect(existsSync(join(dist, "styles.css"))).toBe(true);

    const sourceCss = readFileSync(join(packageRoot, "styles.css"), "utf8");
    expect(readFileSync(join(dist, "styles.css"), "utf8")).toBe(sourceCss);
  });
});
