import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/handler.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/handler.js",
  platform: "node",
  sourcemap: false,
  target: "node24",
  logLevel: "info",
  banner: {
    js: `import { createRequire } from "module"; const require = createRequire(import.meta.url);`,
  },
});
