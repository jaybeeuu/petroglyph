import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/index.js",
  platform: "node",
  sourcemap: false,
  logLevel: "info",
});
