import esbuild from "esbuild";

// The forwarder lambda entry — bundled separately from the library barrel
// (dist/index.js is the tsc build consumers import via `exports`).
await esbuild.build({
  entryPoints: ["src/lambda.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/lambda.js",
  platform: "node",
  sourcemap: false,
  target: "node24",
  logLevel: "info",
  banner: {
    js: `import { createRequire } from "module"; const require = createRequire(import.meta.url);`,
  },
});
