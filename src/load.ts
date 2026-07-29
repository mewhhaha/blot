// Module loading.
//
// A module is a function from an input record to an export record. Importing
// one grants it nothing: it sees only the record its caller hands it, and the
// entry module's record is the entire authority the program has.
//
// Resolution happens before evaluation, so `@import` never touches the disk
// while a program is running and the evaluator can stay synchronous.

import { fromFileUrl, isAbsolute, resolve } from "@std/path";
import type { Decl, Expr, Module } from "./syntax/ast.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { BlotError, render } from "./diagnostic.ts";
import { parse } from "./syntax/parse.ts";
import { childEnv, type Env, type Value } from "./comptime/value.ts";
import { moduleClosure } from "./comptime/eval.ts";

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
  readonly source: string;
  readonly path: string;
}

/** `blot:name` names a prelude module; anything else is a path. */
export function resolvePath(specifier: string, importer: string): string {
  if (specifier.startsWith("blot:")) {
    return resolve(PRELUDE_ROOT, `${specifier.slice("blot:".length)}.blot`);
  }
  if (isAbsolute(specifier)) return specifier;
  return resolve(importer, "..", specifier);
}

function collectImports(expr: Expr, found: Set<string>): void {
  switch (expr.tag) {
    case "apply":
      if (
        expr.fn.tag === "intrinsic" && expr.fn.name === "@import" &&
        expr.arg.tag === "text"
      ) {
        found.add(expr.arg.value);
      }
      collectImports(expr.fn, found);
      collectImports(expr.arg, found);
      return;
    case "field":
      collectImports(expr.target, found);
      return;
    case "lambda":
      collectImports(expr.body, found);
      return;
    case "rec":
      collectImports(expr.lambda, found);
      return;
    case "comptime":
      collectImports(expr.body, found);
      return;
    case "tuple":
      for (const element of expr.elements) collectImports(element, found);
      return;
    case "array":
      for (const element of expr.elements) collectImports(element.value, found);
      return;
    case "shape":
      for (const member of expr.members) collectImports(member.value, found);
      return;
    case "if":
      for (const branch of expr.branches) {
        collectImports(branch.condition, found);
        collectImports(branch.consequence, found);
      }
      if (expr.fallback !== null) collectImports(expr.fallback, found);
      return;
    case "case":
      collectImports(expr.target, found);
      for (const arm of expr.arms) collectImports(arm.body, found);
      return;
    case "block":
      for (const declaration of expr.declarations) {
        collectDecl(declaration, found);
      }
      collectImports(expr.result, found);
      return;
    default:
      return;
  }
}

function collectDecl(declaration: Decl, found: Set<string>): void {
  if (declaration.tag === "for") {
    collectImports(declaration.source, found);
    for (const inner of declaration.body) collectDecl(inner, found);
    return;
  }
  collectImports(declaration.value, found);
}

export function moduleImports(module: Module): readonly string[] {
  const found = new Set<string>();
  for (const declaration of module.declarations) collectDecl(declaration, found);
  collectImports(module.result, found);
  return [...found];
}

/**
 * One cache per process, not per call.
 *
 * Inference records facts for the backend keyed by AST node identity, so two
 * `load` calls returning two structurally equal trees would silently lose every
 * one of them. Sharing the cache is what keeps "the module" a single thing.
 */
const modules = new Map<string, Loaded>();

export async function load(
  path: string,
  cache: Map<string, Loaded> = modules,
  active: Set<string> = new Set(),
): Promise<Loaded> {
  const absolute = resolve(path);
  const cached = cache.get(absolute);
  if (cached !== undefined) return cached;

  if (active.has(absolute)) {
    throw new Error(`blot import cycle through ${absolute}`);
  }
  active.add(absolute);

  const source = await Deno.readTextFile(absolute);
  const parsed = await parse(source);
  if (!parsed.ok) {
    throw new LoadError(absolute, source, parsed.diagnostics);
  }

  const imports = new Map<string, Value>();
  for (const specifier of moduleImports(parsed.module)) {
    const dependency = await load(
      resolvePath(specifier, absolute),
      cache,
      active,
    );
    imports.set(specifier, dependency.closure);
  }

  // Nothing is in scope that the module did not ask for. The prelude is an
  // ordinary module with no privilege: `open (@import "blot:prelude") ();` is
  // what puts `Num.add` where the default fixity for `+` can find it, and a
  // module that does not open it does not have `+`.
  const env: Env = childEnv(null);

  const loaded: Loaded = {
    module: parsed.module,
    closure: moduleClosure(parsed.module, env, imports),
    source,
    path: absolute,
  };

  active.delete(absolute);
  cache.set(absolute, loaded);
  return loaded;
}

export { BlotError };
