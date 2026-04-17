import esbuild from "esbuild";

const dev = process.argv.includes("--dev");

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian"],
  format: "cjs",
  outfile: "dist/main.js",
  platform: "node",
  sourcemap: dev ? "inline" : false,
  logLevel: "info",
});
