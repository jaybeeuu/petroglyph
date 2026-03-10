// @ts-check
import { includeIgnoreFile } from "@eslint/compat";
import { base } from "@jaybeeuu/eslint-config/base";
import globals from "globals";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "typescript-eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default config(includeIgnoreFile(path.resolve(__dirname, ".gitignore")), ...base, {
  languageOptions: {
    globals: {
      ...globals.node,
    },
  },
});
