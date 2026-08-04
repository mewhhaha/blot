// Module loading.
//
// A module is a function from an input record to an export record. Importing
// one grants it nothing: it sees only the record its caller hands it, and the
// entry module's record is the entire authority the program has.
//
// Resolution happens before evaluation, so `@import` never touches the disk
// while a program is running and the evaluator can stay synchronous.

import { dirname, fromFileUrl, isAbsolute, relative, resolve } from "@std/path";
import type { Expr, Module } from "./syntax/ast.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { BlotError, render } from "./diagnostic.ts";
import { parse } from "./syntax/parse.ts";
import { childEnv, type Env, shapeOf, type Value } from "./comptime/value.ts";
import { includedFileKey, moduleClosure } from "./comptime/eval.ts";

const PRELUDE_ROOT = fromFileUrl(new URL("./prelude/", import.meta.url));
export const PRELUDE = resolve(PRELUDE_ROOT, "prelude.blot");

export class LoadError extends Error {
  constructor(
    readonly path: string,
    readonly source: string,
    readonly diagnostics: readonly Diagnostic[],
  ) {
    super(diagnostics.map((d) => render(path, source, d)).join("\n"));
    this.name = "LoadError";
  }
}

export interface Loaded {
  readonly module: Module;
  readonly closure: Value;
  readonly dependencies: ReadonlyMap<string, Loaded>;
  readonly includedFiles: ReadonlyMap<string, IncludedFile>;
  readonly source: string;
  readonly path: string;
}

export interface IncludedFile {
  readonly path: string;
  readonly source: string;
}

/** `blot:name` names a prelude module; anything else is a path. */
export function resolvePath(specifier: string, importer: string): string {
  if (specifier.startsWith("blot:")) {
    return resolve(PRELUDE_ROOT, `${specifier.slice("blot:".length)}.blot`);
  }
  if (isAbsolute(specifier)) return specifier;
  return resolve(importer, "..", specifier);
}

interface DependencySites {
  readonly imports: Map<Expr, string>;
  readonly includes: Map<Expr, string>;
  readonly invalidIncludePaths: Expr[];
}

function collectDependencies(expr: Expr, found: DependencySites): void {
  switch (expr.tag) {
    case "apply":
      if (
        expr.fn.tag === "intrinsic" && expr.fn.name === "@import" &&
        expr.arg.tag === "text"
      ) {
        found.imports.set(expr.arg, expr.arg.value);
      }
      if (expr.fn.tag === "intrinsic" && expr.fn.name === "@include") {
        if (expr.arg.tag === "text") {
          found.includes.set(expr.arg, expr.arg.value);
        } else {
          found.invalidIncludePaths.push(expr.arg);
        }
      }
      collectDependencies(expr.fn, found);
      collectDependencies(expr.arg, found);
      return;
    case "field":
      collectDependencies(expr.target, found);
      return;
    case "lambda":
      collectDependencies(expr.body, found);
      return;
    case "rec":
      collectDependencies(expr.lambda, found);
      return;
    case "comptime":
      collectDependencies(expr.body, found);
      return;
    case "tuple":
      for (const element of expr.elements) {
        collectDependencies(element, found);
      }
      return;
    case "array":
      for (const element of expr.elements) {
        collectDependencies(element.value, found);
      }
      return;
    case "shape":
      for (const member of expr.members) {
        collectDependencies(member.value, found);
      }
      return;
    case "if":
      for (const branch of expr.branches) {
        collectDependencies(branch.condition, found);
        collectDependencies(branch.consequence, found);
      }
      if (expr.fallback !== null) {
        collectDependencies(expr.fallback, found);
      }
      return;
    case "case":
      collectDependencies(expr.target, found);
      for (const arm of expr.arms) {
        collectDependencies(arm.body, found);
      }
      return;
    case "block":
      for (const declaration of expr.declarations) {
        collectDependencies(declaration.value, found);
      }
      collectDependencies(expr.result, found);
      return;
    default:
      return;
  }
}

export function moduleImports(module: Module): readonly string[] {
  const found = importExpressions(module);
  return [...new Set(found.values())];
}

export function moduleIncludes(module: Module): readonly string[] {
  const found = includeExpressions(module);
  return [...new Set(found.values())];
}

export function importExpressions(module: Module): ReadonlyMap<Expr, string> {
  return dependencyExpressions(module).imports;
}

export function includeExpressions(module: Module): ReadonlyMap<Expr, string> {
  return dependencyExpressions(module).includes;
}

function dependencyExpressions(module: Module): DependencySites {
  const found: DependencySites = {
    imports: new Map(),
    includes: new Map(),
    invalidIncludePaths: [],
  };
  for (const declaration of module.declarations) {
    collectDependencies(declaration.value, found);
  }
  collectDependencies(module.result, found);
  return found;
}

/**
 * One cache per process, not per call.
 *
 * Inference records facts for the backend keyed by AST node identity, so two
 * `load` calls returning two structurally equal trees would silently lose every
 * one of them. Sharing the cache is what keeps "the module" a single thing.
 */
const modules = new Map<string, Loaded>();

/**
 * Drop cached modules whose files changed, together with every importer that captured them.
 *
 * A resident compiler cannot trust paths alone: inference and comptime facts are keyed by the AST
 * objects in this cache. Reading the known graph before each service build keeps those identities
 * stable for unchanged files and replaces the complete dependent closure after an edit.
 */
export async function refreshLoadedModules(): Promise<void> {
  const changed = new Set<string>();
  await Promise.all([...modules].map(async ([path, loaded]) => {
    try {
      if (await Deno.readTextFile(path) !== loaded.source) changed.add(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        changed.add(path);
        return;
      }
      throw new Error(
        `could not refresh cached Blot source ${JSON.stringify(path)}`,
        {
          cause: error,
        },
      );
    }
    for (const included of loaded.includedFiles.values()) {
      try {
        if (await Deno.readTextFile(included.path) !== included.source) {
          changed.add(path);
          return;
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          changed.add(path);
          return;
        }
        throw new Error(
          `could not refresh included Blot file ${
            JSON.stringify(included.path)
          }`,
          { cause: error },
        );
      }
    }
  }));
  if (changed.size === 0) return;

  let foundDependent = true;
  while (foundDependent) {
    foundDependent = false;
    for (const [path, loaded] of modules) {
      if (changed.has(path)) continue;
      if (
        [...loaded.dependencies.values()].some((dependency) =>
          changed.has(dependency.path)
        )
      ) {
        changed.add(path);
        foundDependent = true;
      }
    }
  }
  for (const path of changed) modules.delete(path);
}

export async function load(
  path: string,
  cache: Map<string, Loaded> = modules,
  active: readonly string[] = [],
): Promise<Loaded> {
  const absolute = resolve(path);
  const cached = cache.get(absolute);
  if (cached !== undefined) return cached;

  const cycleStart = active.indexOf(absolute);
  if (cycleStart >= 0) {
    const cycle = [...active.slice(cycleStart), absolute];
    throw new BlotError({
      code: "BLOT_IMPORT_CYCLE",
      message: `Import cycle: ${cycle.join(" -> ")}.`,
      span: { start: 0, end: 0 },
    });
  }
  const nextActive = [...active, absolute];

  const source = await Deno.readTextFile(absolute);
  const parsed = await parse(source);
  if (!parsed.ok) {
    throw new LoadError(absolute, source, parsed.diagnostics);
  }

  const dependencySites = dependencyExpressions(parsed.module);
  const invalidIncludePath = dependencySites.invalidIncludePaths[0];
  if (invalidIncludePath !== undefined) {
    throw new LoadError(absolute, source, [{
      code: "BLOT_INCLUDE_PATH",
      message: "`@include` requires a literal text path.",
      span: invalidIncludePath.span,
    }]);
  }

  const imports = new Map<string, Value>();
  const dependencies = new Map<string, Loaded>();
  for (const specifier of new Set(dependencySites.imports.values())) {
    const dependency = await load(
      resolvePath(specifier, absolute),
      cache,
      nextActive,
    );
    imports.set(specifier, dependency.closure);
    dependencies.set(specifier, dependency);
  }

  const includedFiles = new Map<string, IncludedFile>();
  for (const [site, specifier] of dependencySites.includes) {
    let includedPath = specifier;
    if (!isAbsolute(specifier)) {
      includedPath = resolve(dirname(absolute), specifier);
    }
    let includedSource: string;
    try {
      includedSource = await Deno.readTextFile(includedPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new LoadError(absolute, source, [{
          code: "BLOT_INCLUDE_NOT_FOUND",
          message: `Included file \`${specifier}\` does not exist.`,
          span: site.span,
        }]);
      }
      throw new Error(
        `could not read included Blot file ${JSON.stringify(includedPath)}`,
        { cause: error },
      );
    }
    includedFiles.set(specifier, {
      path: includedPath,
      source: includedSource,
    });
    let normalizedPath = relative(dirname(absolute), includedPath);
    normalizedPath = normalizedPath.replaceAll("\\", "/");
    if (!normalizedPath.startsWith(".")) normalizedPath = `./${normalizedPath}`;
    imports.set(
      includedFileKey(specifier),
      shapeOf([
        ["specifier", { tag: "text", value: specifier }],
        ["path", { tag: "text", value: normalizedPath }],
        ["text", { tag: "text", value: includedSource }],
      ]),
    );
  }

  // Nothing is in scope that the module did not ask for. The prelude is an
  // ordinary module with no privilege: `open {} = (@import "blot:prelude") ();` is
  // what puts `Num.add` where the default fixity for `+` can find it, and a
  // module that does not open it does not have `+`.
  const env: Env = childEnv(null);

  const loaded: Loaded = {
    module: parsed.module,
    closure: moduleClosure(parsed.module, env, imports),
    dependencies,
    includedFiles,
    source,
    path: absolute,
  };

  cache.set(absolute, loaded);
  return loaded;
}

export { BlotError };
