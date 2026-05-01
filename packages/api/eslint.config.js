// @ts-check
import rootConfig from "../../eslint.config.js";
import { config } from "typescript-eslint";

export default config(...rootConfig, {
  ignores: ["src/openapi-types.ts"],
});
