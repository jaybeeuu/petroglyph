// @ts-check
import { base } from "@jaybeeuu/eslint-config/base";
import globals from "globals";
import { config } from "typescript-eslint";

const LAZY_RESOURCE_MESSAGE =
  "Build this lazily at first use (a `??=` accessor or a factory), not at module scope: importing a module must have no effects (petroglyph-1o2d).";

// Matches a resource construction anywhere outside a lazy boundary, so a
// module-scope expression cannot hide in a default export, a bare statement, or
// a static class field — while arrowing, function and instance-field forms stay
// legal. A `??=` accessor is a function body, so it is allowed.
const ALLOWED_BOUNDARIES = [
  "FunctionDeclaration *",
  "FunctionExpression *",
  "ArrowFunctionExpression *",
  "PropertyDefinition[static=false] *",
].join(", ");

const moduleScopeRules = (expression) => [
  {
    selector: `${expression}:not(${ALLOWED_BOUNDARIES})`,
    message: LAZY_RESOURCE_MESSAGE,
  },
];

export default config(
  {
    ignores: [
      ".dolt/",
      ".beads",
      ".vscode",
      "node_modules/",
      "**/dist/",
      "**/release/",
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
  {
    rules: {
      "no-restricted-syntax": [
        "error",
        ...moduleScopeRules("NewExpression[callee.name=/Client$/]"),
        ...moduleScopeRules("NewExpression[callee.name='Hono']"),
      ],
    },
  },
);
