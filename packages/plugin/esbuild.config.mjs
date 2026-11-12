import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const dev = process.argv.includes("--dev");
// `--release` stages the loadable plugin folder Obsidian can be given; without it the
// build lands in `dist/`, which is a development artefact.
const release = process.argv.includes("--release");
const packageRoot = dirname(fileURLToPath(import.meta.url));
const outDir = join(packageRoot, release ? "release" : "dist");

if (release) {
  // Start clean so a file from an earlier release cannot survive into this one.
  rmSync(outDir, { recursive: true, force: true });
}

await esbuild.build({
  entryPoints: [join(packageRoot, "src/main.ts")],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  outfile: join(outDir, "main.js"),
  platform: "node",
  sourcemap: dev ? "inline" : false,
  logLevel: "info",
});

// Assemble the plugin folder Obsidian loads: main.js + manifest.json + styles.css.
// `manifest.json` is copied verbatim, so it is the only place the plugin version lives.
mkdirSync(outDir, { recursive: true });
for (const file of ["manifest.json", "styles.css"]) {
  cpSync(join(packageRoot, file), join(outDir, file));
}
