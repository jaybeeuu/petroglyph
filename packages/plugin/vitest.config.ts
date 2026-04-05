import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: resolve(import.meta.dirname, "src/__mocks__/obsidian.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
