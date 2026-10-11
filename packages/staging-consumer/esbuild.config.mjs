import esbuild from "esbuild";

// The lambda entries — bundled separately from the library barrel
// (dist/index.js is the tsc build consumers import via `exports`).
const common = {
  bundle: true,
  format: "esm",
  platform: "node",
  sourcemap: false,
  target: "node24",
  logLevel: "info",
  banner: {
    js: `import { createRequire } from "module"; const require = createRequire(import.meta.url);`,
  },
};

await esbuild.build({
  ...common,
  entryPoints: ["src/lambda.ts"],
  outfile: "dist/lambda.js",
});

await esbuild.build({
  ...common,
  entryPoints: ["src/dispatch-lambda.ts"],
  outfile: "dist/dispatch-lambda.js",
});
