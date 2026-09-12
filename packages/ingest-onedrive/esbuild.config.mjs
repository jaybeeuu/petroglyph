import esbuild from "esbuild";

// Two lambda entries from one package:
//  - dist/index.js  — the webhook receiver (existing, handler dist/index.handler)
//  - dist/lambda.js — the 6ra adapter delta driver (handler dist/lambda.handler)
await esbuild.build({
  entryPoints: ["src/index.ts", "src/lambda.ts"],
  bundle: true,
  format: "esm",
  outdir: "dist",
  entryNames: "[name]",
  platform: "node",
  sourcemap: false,
  target: "node24",
  logLevel: "info",
  banner: {
    js: `import { createRequire } from "module"; const require = createRequire(import.meta.url);`,
  },
});
