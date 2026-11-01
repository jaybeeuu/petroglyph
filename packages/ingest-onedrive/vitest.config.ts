import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    // Four suites here each start their own LocalStack container. Started together they
    // hold four LocalStack JVMs in memory at once, and on a loaded machine with little
    // free RAM they thrash until the `beforeAll` budget runs out. Run the files one at a
    // time so only one container is starting at any moment.
    fileParallelism: false,
    server: {
      deps: {
        // The packaging smoke test imports the built Lambda bundles straight out of the
        // extracted zip. They are megabytes of already-bundled JavaScript, so Vite's
        // transform pipeline is pure overhead there: it takes ~15 s per bundle instead of
        // the ~2 s a plain `node` import needs. Keep them external so Node loads them as-is.
        external: [/[\\/]\.test-extract[\\/]/],
      },
    },
  },
});
