import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installPlugin } from "./install.mjs";

const STAGED_FILES = ["main.js", "manifest.json", "styles.css"];

let tempRoot;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "petroglyph-install-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const createVault = () => {
  const vaultDir = join(tempRoot, "vault");
  mkdirSync(join(vaultDir, ".obsidian"), { recursive: true });
  return vaultDir;
};

const createStagedPlugin = () => {
  const stagedDir = join(tempRoot, "release");
  mkdirSync(stagedDir, { recursive: true });
  for (const file of STAGED_FILES) {
    writeFileSync(join(stagedDir, file), "staged");
  }
  return stagedDir;
};

describe("installPlugin", () => {
  it("refuses to run without a vault path", () => {
    const outcome = installPlugin({ stagedDir: createStagedPlugin() });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("vault");
  });

  it("refuses a directory that is not a vault", () => {
    const notAVault = join(tempRoot, "not-a-vault");
    mkdirSync(notAVault);

    const outcome = installPlugin({ vaultArgument: notAVault, stagedDir: createStagedPlugin() });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain(".obsidian");
  });

  it("refuses when nothing has been staged", () => {
    const outcome = installPlugin({
      vaultArgument: createVault(),
      stagedDir: join(tempRoot, "missing"),
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain("package");
  });

  it("copies the staged plugin into the vault plugin folder", () => {
    const vaultDir = createVault();

    const outcome = installPlugin({ vaultArgument: vaultDir, stagedDir: createStagedPlugin() });

    expect(outcome).toEqual({
      ok: true,
      targetDir: join(vaultDir, ".obsidian", "plugins", "petroglyph"),
    });
    for (const file of STAGED_FILES) {
      expect(existsSync(join(vaultDir, ".obsidian", "plugins", "petroglyph", file))).toBe(true);
    }
  });
});
