import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Every suite here executes shell scripts that spawn stub processes. Run the
    // files one at a time so those process trees do not fight each other for
    // CPU: run in parallel on a loaded machine, the deploy-workflow tests took
    // up to 63 s each instead of the 1-3 s they take alone, and the package
    // took 91 s instead of 25 s.
    fileParallelism: false,
  },
});
