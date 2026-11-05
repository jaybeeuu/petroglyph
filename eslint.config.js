// @ts-check
import { base } from "@jaybeeuu/eslint-config/base";
import globals from "globals";
import { config } from "typescript-eslint";

const LAZY_RESOURCE_MESSAGE =
  "Build this lazily at first use (a `??=` accessor or a factory), not at module scope: importing a module must have no effects (petroglyph-1o2d).";

// Matches a resource construction whose initialiser sits directly on the module
// scope, including nested ones such as `DocumentClient.from(new Client({}))`.
const moduleScopeRules = (expression) =>
  [
    `Program > VariableDeclaration > VariableDeclarator ${expression}`,
    `Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator ${expression}`,
  ].map((selector) => ({ selector, message: LAZY_RESOURCE_MESSAGE }));

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
