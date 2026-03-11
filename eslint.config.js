// @ts-check
import { base } from "@jaybeeuu/eslint-config/base";
import globals from "globals";
import { config } from "typescript-eslint";

export default config(
  {
    ignores: [
      ".dolt/",
      ".beads",
      ".vscode",
      "node_modules/",
      "**/dist/",
      "**/*.tsbuildinfo",
      ".pnpm-store/",
    ],
  },
  ...base,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
