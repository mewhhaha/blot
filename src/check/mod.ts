// Type checking a file.
//
// Checking needs the comptime evaluator, and that is not an accident of the
// implementation: a `sig` is an ordinary expression and a `const` may *be* a
// type, so the two cannot be separated. It is the same trade that removed the
// type sublanguage from the grammar.

import type { Diagnostic } from "../diagnostic.ts";
import { BlotError } from "../diagnostic.ts";
import { importExpressions, load, type Loaded } from "../load.ts";
import {
  childEnv,
  type Env as ValueEnv,
  type Value,
} from "../comptime/value.ts";
import {
  type Checked,
  checkModule,
  type GrantSignature,
  newStaging,
  settle,
  type Shape,
  type Staging,
  type TaggedDeclaration,
  type VariantCase,
} from "./infer.ts";
import type { Decl, Expr, Pattern, Span } from "../syntax/ast.ts";
import type { SimpleType } from "./type.ts";
import { show, showModuleRow as showRow } from "./print.ts";
import { isHostEffect } from "./bridge.ts";
import { TypeError_ } from "./constrain.ts";
import {
  checkLinearity,
  type NamePattern,
  type Ownership,
} from "../linear/check.ts";

/**
 * What the linearity pass proved about one binding, once it has left its module.
 *
 * The path is part of the fact rather than of the result, for the same reason a
 * diagnostic carries its origin: a dependency's spans index the dependency's
 * source, and an importer that resolved them against its own file would name
 * the wrong line. Anything turning one of these into a location has to read the
 * file the fact came from.
 */
export interface OwnedBinding {
  readonly path: string;
  /**
   * Where the binding was last read, or null when nothing read it. Traversal
   * order, not a deadness proof — see `Ownership.lastUses` for why the
   * distinction matters to anything that would act on it.
   */
  readonly lastUse: Span | null;
  /** Its linear or affine obligation was proved discharged exactly once. */
  readonly spent: boolean;
  /**
   * `lastUse` is the last read walked, not the last read taken; see
   * `Ownership.reentrant`. Anything that would treat that read as the binding's
   * death has to refuse when this is set.
   */
  readonly reentrant: boolean;
}

export interface CheckResult {
  readonly type: string;
  readonly effects: string;
  /** Inferred module result retained for specialization and boundary lowering. */
  readonly moduleType: SimpleType;
  /** Inferred module row retained for the emitted ABI manifest. */
  readonly moduleEffects: SimpleType;
  /**
   * Ownership facts for every module that contributed code, keyed by the `name`
   * pattern that bound each binding. The backend inlines an imported module
   * into its importer, so an importer's facts have to cover the dependency's
   * bindings too — the same reason `shapes` and `variants` merge.
   */
  readonly ownership: ReadonlyMap<NamePattern, OwnedBinding>;
  /** What each `open` brought into scope; see `Checked`. */
  readonly opens: ReadonlyMap<Expr, ReadonlyMap<string, Value>>;
  /** Compile-time declaration values; see `Checked`. */
  readonly comptimeValues: ReadonlyMap<Expr, Value>;
  /** Field and constructor sets the backend needs; see `Checked`. */
  readonly shapes: ReadonlyMap<Expr, Shape>;
  readonly variants: ReadonlyMap<Expr, readonly VariantCase[]>;
  readonly patternShapes: ReadonlyMap<Pattern, Shape>;
  readonly grants: ReadonlyMap<Expr, GrantSignature>;
  /** Resolved declaration tags, keyed by the tagged binding's AST identity. */
  readonly declarationTags: ReadonlyMap<Decl, TaggedDeclaration>;
  /** Checked dependencies keyed by each literal import site. */
  readonly modules: ReadonlyMap<
    Expr,
    { readonly module: Loaded["module"]; readonly values: ValueEnv }
  >;
  /**
   * The module's compile-time bindings, including its own `const`s.
   *
   * Checking has to evaluate them anyway — a `const` may *be* a type — so the
   * backend reuses the results instead of running the evaluator twice.
   */
  readonly values: ValueEnv;
}

function imports(loaded: Loaded) {
  if (loaded.closure.tag !== "closure") return new Map();
  return loaded.closure.imports ?? new Map();
}

/**
 * Check one program: its root module and everything that module imports.
 *
 * Two passes, because a fact and a diagnostic want opposite moments. A
 * diagnostic belongs to the module that caused it, so checking runs bottom-up
 * and a dependency's error is reported against the dependency's source. A field
 * set belongs to the whole program: the record that reaches `fn c => c.zoom`
 * may be built two files away, so the reads that answer it are held in one
 * `Staging` and settled once, after every module has contributed its
 * constraints. Only then is there an answer to assemble into results.
 */
export async function checkFile(path: string): Promise<CheckResult> {
  const loaded = await load(path);
  // Per call, not per process. A dependency's facts depend on its importers, so
  // there is no one answer it could carry between two programs — and since they
  // are keyed by AST node identity, one map could not hold both answers anyway.
  // The loader's cache does stay process-wide, which is what keeps those
  // identities stable from one call to the next.
  const checkedFiles = new Map<Loaded, CheckedFile>();
  const staging = newStaging();
  checkLoaded(loaded, checkedFiles, staging);
  settle(staging);
  return assemble(loaded, checkedFiles, new Map());
}

interface CheckedFile {
  readonly checked: Checked;
  /** The row as the boundary check saw it, so what is reported is what passed. */
  readonly effects: string;
  readonly ownership: ReadonlyMap<NamePattern, OwnedBinding>;
  readonly values: ValueEnv;
}

function checkLoaded(
  loaded: Loaded,
  cache: Map<Loaded, CheckedFile>,
  staging: Staging,
): CheckedFile {
  const cached = cache.get(loaded);
  if (cached !== undefined) return cached;

  if (loaded.closure.tag !== "closure") {
    throw new Error("a module must load as a closure");
  }

  // Nothing is seeded. The prelude is reached through `@import` like any other
  // module, so its exports arrive as a dependency's type and `assemble` folds
  // its facts in the way it folds any other's — there is no branch here that
  // knows what a prelude is.
  const values = childEnv(loaded.closure.env);

  // Each dependency is checked before its importer, so a module's exports are
  // visible as types rather than as an opaque value.
  const modules = new Map<string, SimpleType>();
  for (const [specifier, dependency] of loaded.dependencies) {
    const dependencyChecked = checkLoaded(dependency, cache, staging);
    // The module's own parameter variable, not a stand-in for it. A fresh
    // variable here would satisfy every argument, so an importer could omit a
    // field the module reads and nothing would say so — and the record it does
    // pass would never reach the projections inside the module that decide
    // their nominal.
    const parameter = dependencyChecked.checked.parameter;
    modules.set(specifier, {
      tag: "fun",
      param: parameter === null ? { tag: "unit" as const } : parameter,
      effects: dependencyChecked.checked.effects,
      result: dependencyChecked.checked.type,
    });
  }

  try {
    const checked = checkModule(
      loaded.module,
      values,
      imports(loaded),
      null,
      modules,
      staging,
    );
    // A module's own row is what it performs that nothing handled. Non-empty at
    // the top level means the program would reach a `perform` with no handler
    // installed, which is exactly the runtime failure — caught statically here.
    const row = showRow(checked.effects);
    const escaping = unhandledRow(checked.effects);
    if (escaping !== "") {
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
    const complete: CheckedFile = {
      checked,
      effects: row,
      ownership: own(loaded.path, linear.ownership),
      values,
    };
    cache.set(loaded, complete);
    return complete;
  } catch (error) {
    // The innermost module still being checked is the one its spans index into,
    // so an importer must not relabel a dependency's diagnostic as its own.
    const origin = { path: loaded.path, source: loaded.source };
    if (error instanceof TypeError_) {
      throw new BlotError(
        {
          code: "BLOT_TYPE_ERROR",
          message: `${error.detail}.`,
          span: loaded.module.span,
        } satisfies Diagnostic,
        origin,
      );
    }
    if (error instanceof BlotError && error.origin === null) {
      throw new BlotError(error.diagnostic, origin);
    }
    throw error;
  }
}

/**
 * One module's result, with every fact its dependencies contributed folded in.
 *
 * The backend inlines an imported module into its importer, so an importer's
 * facts have to cover the dependency's bindings too — which is why every map
 * here merges the dependency's before adding this module's own. Runs only after
 * the compilation has settled: before that, a fact map is a promise rather than
 * an answer, and merging it would copy the empty promise.
 *
 * Memoized because a diamond would otherwise assemble a shared dependency once
 * per path to it.
 */
function assemble(
  loaded: Loaded,
  cache: ReadonlyMap<Loaded, CheckedFile>,
  results: Map<Loaded, CheckResult>,
): CheckResult {
  const done = results.get(loaded);
  if (done !== undefined) return done;

  const file = cache.get(loaded);
  if (file === undefined) {
    throw new Error(
      `module ${loaded.path} was assembled before it was checked`,
    );
  }
  const dependencies = new Map<string, CheckResult>();
  for (const [specifier, dependency] of loaded.dependencies) {
    dependencies.set(specifier, assemble(dependency, cache, results));
  }
  // A dependency's assembled result, not the `Checked` of its own module: an
  // importer's importer inlines the whole subtree, so a fact found two levels
  // down has to arrive here too.
  const below = [...dependencies.values()];

  const checked = file.checked;
  const result: CheckResult = {
    type: show(checked.type),
    effects: file.effects,
    moduleType: checked.type,
    moduleEffects: checked.effects,
    ownership: mergeAll([
      ...below.map((dependency) => dependency.ownership),
      file.ownership,
    ]),
    opens: mergeAll([
      ...below.map((dependency) => dependency.opens),
      checked.opens,
    ]),
    comptimeValues: mergeAll([
      ...below.map((dependency) => dependency.comptimeValues),
      checked.comptimeValues,
    ]),
    shapes: mergeAll([
      ...below.map((dependency) => dependency.shapes),
      checked.shapes,
    ]),
    variants: mergeAll([
      ...below.map((dependency) => dependency.variants),
      checked.variants,
    ]),
    patternShapes: mergeAll([
      ...below.map((dependency) => dependency.patternShapes),
      checked.patternShapes,
    ]),
    declarationTags: mergeAll([
      ...below.map((dependency) => dependency.declarationTags),
      checked.declarationTags,
    ]),
    grants: checked.grants,
    modules: mergeAll([
      ...below.map((dependency) => dependency.modules),
      importSites(loaded, dependencies),
    ]),
    values: file.values,
  };
  results.set(loaded, result);
  return result;
}

/** Each literal `@import` in one module, paired with what it resolved to. */
function importSites(
  loaded: Loaded,
  dependencies: ReadonlyMap<string, CheckResult>,
): ReadonlyMap<Expr, { module: Loaded["module"]; values: ValueEnv }> {
  const sites = new Map<Expr, { module: Loaded["module"]; values: ValueEnv }>();
  for (const [site, specifier] of importExpressions(loaded.module)) {
    const dependency = dependencies.get(specifier);
    const resolved = loaded.dependencies.get(specifier);
    if (dependency === undefined || resolved === undefined) {
      throw new Error(
        `loaded module ${loaded.path} omitted dependency ${specifier}`,
      );
    }
    sites.set(site, { module: resolved.module, values: dependency.values });
  }
  return sites;
}

/**
 * The part of a module's row nothing accounts for.
 *
 * A host effect's operations become WebAssembly imports, so its row *is* the
 * program's declared interface and reaching the boundary is what it is for. An
 * ordinary effect there is a program that would perform with no handler
 * installed.
 */
function unhandledRow(effects: SimpleType): string {
  const labels = rowLabels(effects, new Set()).filter((label) =>
    !isHostEffect(label)
  );
  if (labels.length === 0) return "";
  const shown = labels.map((label) => label.replace(/#\d+$/, "")).sort();
  return `{ ${shown.join(", ")} }`;
}

function rowLabels(type: SimpleType, seen: Set<number>): string[] {
  if (type.tag === "effects") return [...type.labels];
  if (type.tag !== "var" || seen.has(type.id)) return [];
  seen.add(type.id);
  return type.lower.flatMap((bound) => rowLabels(bound, seen));
}

/**
 * Stamps one module's ownership facts with the file its spans index.
 *
 * A binding appears if the pass said anything about it: a linear one it proved
 * discharged is worth recording even where the surrounding expression never
 * read it back, and a plain one that was read is worth recording even though it
 * owes nothing.
 */
function own(
  path: string,
  ownership: Ownership,
): ReadonlyMap<NamePattern, OwnedBinding> {
  const facts = new Map<NamePattern, OwnedBinding>();
  for (const [pattern, lastUse] of ownership.lastUses) {
    facts.set(pattern, {
      path,
      lastUse,
      spent: ownership.linear.has(pattern),
      reentrant: ownership.reentrant.has(pattern),
    });
  }
  for (const pattern of ownership.linear) {
    if (facts.has(pattern)) continue;
    // Nothing read it, so there is no read to be wrong about when it happened.
    facts.set(pattern, { path, lastUse: null, spent: true, reentrant: false });
  }
  return facts;
}

/** Facts from every module that contributed code; keys are node identities. */
function mergeAll<Key, Value>(
  sources: readonly (ReadonlyMap<Key, Value> | undefined)[],
): ReadonlyMap<Key, Value> {
  const merged = new Map<Key, Value>();
  for (const source of sources) {
    if (source === undefined) continue;
    for (const [node, value] of source) merged.set(node, value);
  }
  return merged;
}

export { show };
