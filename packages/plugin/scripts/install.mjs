import { cpSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "petroglyph";
const STAGED_DIR = fileURLToPath(new URL("../release", import.meta.url));
const USAGE =
  "Pass the vault path as the only argument, for example:\n" +
  "  pnpm --filter @petroglyph/plugin install:vault -- /path/to/vault";

const isDirectory = (path) => existsSync(path) && statSync(path).isDirectory();

const resolveInstallPlan = ({ vaultArgument, stagedDir }) => {
  if (!vaultArgument) {
    return { ok: false, message: USAGE };
  }

  const vaultDir = resolve(vaultArgument);

  if (!isDirectory(vaultDir)) {
    return { ok: false, message: `Vault path is not a directory: ${vaultDir}` };
  }

  if (!isDirectory(join(vaultDir, ".obsidian"))) {
    return { ok: false, message: `${vaultDir} has no .obsidian directory, so it is not a vault.` };
  }

  if (!isDirectory(stagedDir)) {
    return {
      ok: false,
      message:
        `Nothing staged at ${stagedDir}. Run ` +
        "`pnpm --filter @petroglyph/plugin package` before installing.",
    };
  }

  return { ok: true, stagedDir, targetDir: join(vaultDir, ".obsidian", "plugins", PLUGIN_ID) };
};

export const installPlugin = ({ vaultArgument, stagedDir = STAGED_DIR }) => {
  const target = resolveInstallPlan({ vaultArgument, stagedDir });

  if (!target.ok) {
    return target;
  }

  mkdirSync(target.targetDir, { recursive: true });
  cpSync(target.stagedDir, target.targetDir, { recursive: true });

  return { ok: true, targetDir: target.targetDir };
};

const isRunDirectly = () =>
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isRunDirectly()) {
  // pnpm forwards a `--` separator as a literal argument.
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const outcome = installPlugin({ vaultArgument: args[0] });

  if (!outcome.ok) {
    process.stderr.write(`${outcome.message}\n`);
    process.exit(1);
  }

  process.stdout.write(`Installed the plugin into ${outcome.targetDir}\n`);
  process.stdout.write("Reload Obsidian, or restart it, to pick up the new build.\n");
}
