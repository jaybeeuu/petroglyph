import { cpSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const dev = process.argv.includes("--dev");
const packageRoot = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(packageRoot, "src/main.ts")],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  outfile: join(packageRoot, "dist/main.js"),
  platform: "node",
  sourcemap: dev ? "inline" : false,
  logLevel: "info",
});

// Assemble the plugin folder Obsidian loads: main.js + manifest.json + styles.css.
const distDir = join(packageRoot, "dist");
mkdirSync(distDir, { recursive: true });
for (const file of ["manifest.json", "styles.css"]) {
  cpSync(join(packageRoot, file), join(distDir, file));
}
