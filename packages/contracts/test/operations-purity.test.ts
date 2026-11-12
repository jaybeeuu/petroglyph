import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const operationsEntry = resolve(sourceRoot, "operations/index.ts");

/** Every `from "..."` and `import "..."` target in one module. */
function importedSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * The source file behind a NodeNext specifier: `./registry.js` on disk is
 * `registry.ts`, because the compiler emits the extension the runtime resolves.
 */
function sourcePath(modulePath: string): string {
  return modulePath.endsWith(".js") ? `${modulePath.slice(0, -".js".length)}.ts` : modulePath;
}

/**
 * Every module the operations entry point loads, following relative imports.
 * Package imports are recorded as-is: they are the ones that could reach an app.
 */
function moduleGraph(entry: string): readonly string[] {
  const visited = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (modulePath === undefined || visited.has(modulePath)) {
      continue;
    }
    visited.add(modulePath);
    for (const specifier of importedSpecifiers(readFileSync(sourcePath(modulePath), "utf8"))) {
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(modulePath), specifier));
      } else {
        visited.add(`package:${specifier}`);
      }
    }
  }
  return [...visited];
}

describe("the operations entry point", () => {
  it("imports only modules inside packages/contracts, never an app or a database client", () => {
    const modules = moduleGraph(operationsEntry);

    const packages = modules.filter((module) => module.startsWith("package:"));
    expect(packages).toStrictEqual(["package:zod"]);

    const escaping = modules.filter(
      (module) => !module.startsWith("package:") && relative(sourceRoot, module).startsWith(".."),
    );
    expect(escaping).toStrictEqual([]);
  });
});
