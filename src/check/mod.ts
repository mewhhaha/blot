// Type checking a file.
//
// Checking needs the comptime evaluator, and that is not an accident of the
// implementation: a `sig` is an ordinary expression and a `const` may *be* a
// type, so the two cannot be separated. It is the same trade that removed the
// type sublanguage from the grammar.

import type { Diagnostic } from "../diagnostic.ts";
import { BlotError } from "../diagnostic.ts";
import {
  load,
  type Loaded,
  moduleImports,
  PRELUDE,
  resolvePath,
} from "../load.ts";
import { childEnv } from "../comptime/value.ts";
import { checkModule } from "./infer.ts";
import { freshVar, type SimpleType } from "./type.ts";
import { show, showModuleRow as showRow } from "./print.ts";
import { TypeError_ } from "./constrain.ts";
import { checkLinearity, type Ownership } from "../linear/check.ts";

export interface CheckResult {
  readonly type: string;
  readonly effects: string;
  readonly ownership: Ownership;
}

/**
 * The prelude's exports, as types.
 *
 * They cannot be bridged from values — most are closures, whose types come from
 * their bodies — so the prelude is checked like any other module and its result
 * record becomes the seed for every other module's scope. It is ordinary blot
 * source and gets no exemption from its own type system.
 */
let preludeTypes: ReadonlyMap<string, SimpleType> | null = null;

async function preludeScope(): Promise<ReadonlyMap<string, SimpleType>> {
  if (preludeTypes !== null) return preludeTypes;
  const prelude = await load(PRELUDE);
  const result = checkModule(
    prelude.module,
    seedValues(prelude),
    imports(prelude),
    null,
  );
  if (result.type.tag !== "record") {
    throw new Error("the prelude must return a shape");
  }
  preludeTypes = result.type.fields;
  return preludeTypes;
}

function seedValues(loaded: Loaded) {
  if (loaded.closure.tag !== "closure") {
    throw new Error("a module must load as a closure");
  }
  return childEnv(loaded.closure.env);
}

function imports(loaded: Loaded) {
  if (loaded.closure.tag !== "closure") return new Map();
  return loaded.closure.imports ?? new Map();
}

export async function checkFile(path: string): Promise<CheckResult> {
  const loaded = await load(path);
  if (loaded.closure.tag !== "closure") {
    throw new Error("a module must load as a closure");
  }

  // Seeded with the prelude exactly as evaluation is, so that `+` resolves to
  // the same `Num.add` in both.
  const scope = path === PRELUDE ? null : await preludeScope();
  const values = childEnv(loaded.closure.env);

  // Each dependency is checked before its importer, so a module's exports are
  // visible as types rather than as an opaque value.
  const modules = new Map<string, SimpleType>();
  for (const specifier of moduleImports(loaded.module)) {
    const dependency = await load(resolvePath(specifier, loaded.path));
    const dependencyScope = dependency.path === PRELUDE
      ? null
      : await preludeScope();
    const checked = checkModule(
      dependency.module,
      seedValues(dependency),
      imports(dependency),
      dependencyScope,
    );
    const parameter = dependency.module.parameter === null
      ? { tag: "unit" as const }
      : freshVar(0);
    modules.set(specifier, {
      tag: "fun",
      param: parameter,
      effects: { tag: "effects", labels: new Set() },
      result: checked.type,
    });
  }

  try {
    const checked = checkModule(
      loaded.module,
      values,
      imports(loaded),
      scope,
      modules,
    );
    // A module's own row is what it performs that nothing handled. Non-empty at
    // the top level means the program would reach a `perform` with no handler
    // installed, which is exactly the runtime failure — caught statically here.
    const row = showRow(checked.effects);
    if (row !== "") {
      throw new BlotError(
        {
          code: "BLOT_UNHANDLED_EFFECT",
          message: `Nothing handles ${row.trim()} at the module boundary.`,
          span: loaded.module.span,
        } satisfies Diagnostic,
      );
    }
    // Ownership is checked after types. A use-after-move reported on a program
    // that does not type-check would be the second-best diagnostic.
    const linear = checkLinearity(loaded.module);
    if (linear.diagnostics.length > 0) {
      throw new BlotError(linear.diagnostics[0]);
    }
    return {
      type: show(checked.type),
      effects: row,
      ownership: linear.ownership,
    };
  } catch (error) {
    if (error instanceof TypeError_) {
      throw new BlotError(
        {
          code: "BLOT_TYPE_ERROR",
          message: `${error.detail}.`,
          span: loaded.module.span,
        } satisfies Diagnostic,
      );
    }
    throw error;
  }
}

export { show };
