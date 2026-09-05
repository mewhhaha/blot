// Module loading.
//
// Node owns filesystem and package resolution, never source semantics. The
// resolved graph is installed into one Rust compiler session before any check,
// evaluation, Runtime-HIR request, or build begins.

import { readFile } from "node:fs/promises";
import { dirname, fromFileUrl, isAbsolute, resolve } from "@std/path";
import type { Expr, Module } from "./syntax/ast.ts";
import type { Diagnostic } from "./diagnostic.ts";
import { BlotError, render } from "./diagnostic.ts";
import { parse, parseConcrete } from "./syntax/parse.ts";
import { decodePortableModule } from "./syntax/portable.ts";
import {
  type CapsuleModule,
  decodeModuleCapsule,
  isPackageSpecifier,
  PackageArtifactError,
  resolvePackageExport,
} from "./package_format.ts";

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
  readonly dependencies: ReadonlyMap<string, Loaded>;
  readonly includedFiles: ReadonlyMap<string, IncludedFile>;
  readonly source: string;
  readonly path: string;
  readonly storage: LoadedStorage;
}

export type LoadedStorage =
  | { readonly tag: "source" }
  | { readonly tag: "snapshot"; readonly digest: string }
  | {
    readonly tag: "capsule";
    readonly path: string;
    readonly source: string;
  };

export interface IncludedFile {
  readonly path: string;
  readonly source: string;
}

export interface InspectedDependencySite {
  readonly specifier: string;
  readonly span: { readonly start: number; readonly end: number };
}

export interface SourceInspection {
  readonly imports: readonly InspectedDependencySite[];
  readonly includes: readonly InspectedDependencySite[];
  readonly moduleHandle: string;
  readonly portableAstDigest: string;
}

export type SourceInspector = (
  path: string,
  source: string,
) => Promise<SourceInspection | undefined> | SourceInspection | undefined;

/** `blot:name` names a prelude module; package specifiers require async resolution. */
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

export function invalidIncludeExpressions(module: Module): readonly Expr[] {
  return dependencyExpressions(module).invalidIncludePaths;
}

const dependencySitesByModule = new WeakMap<Module, DependencySites>();

function dependencyExpressions(module: Module): DependencySites {
  const cached = dependencySitesByModule.get(module);
  if (cached !== undefined) return cached;
  const found: DependencySites = {
    imports: new Map(),
    includes: new Map(),
    invalidIncludePaths: [],
  };
  for (const declaration of module.declarations) {
    collectDependencies(declaration.value, found);
  }
  collectDependencies(module.result, found);
  dependencySitesByModule.set(module, found);
  return found;
}

/**
 * One cache per process, not per call.
 *
 * Syntax tooling benefits from stable AST identity, while compiler caches use
 * exact graph revision keys. No semantic fact is stored in this cache.
 */
const modules = new Map<string, Loaded>();

/** Drops cached modules whose own source, capsule, or included input changed. */
export async function refreshLoadedModules(
  cache: Map<string, Loaded> = modules,
  overlayPaths: ReadonlySet<string> = new Set(),
): Promise<void> {
  const inputs = new Map<
    string,
    { readonly source: string; readonly description: string }
  >();
  for (const [path, loaded] of cache) {
    if (loaded.storage.tag === "snapshot") continue;
    if (loaded.storage.tag === "capsule") {
      inputs.set(loaded.storage.path, {
        source: loaded.storage.source,
        description: "cached Blot module capsule",
      });
      continue;
    }
    if (!overlayPaths.has(path)) {
      inputs.set(path, {
        source: loaded.source,
        description: "cached Blot source",
      });
    }
    for (const included of loaded.includedFiles.values()) {
      inputs.set(included.path, {
        source: included.source,
        description: "included Blot file",
      });
    }
  }

  const changedInputs = new Set<string>();
  await Promise.all([...inputs].map(async ([path, input]) => {
    try {
      if (await readFile(path, "utf8") !== input.source) {
        changedInputs.add(path);
      }
    } catch (error) {
      if (isNotFound(error)) {
        changedInputs.add(path);
        return;
      }
      throw new Error(
        `could not refresh ${input.description} ${JSON.stringify(path)}`,
        { cause: error },
      );
    }
  }));
  invalidateLoadedInputs(cache, changedInputs);
}

/**
 * Removes only modules that directly own a changed filesystem input.
 * Importers retain their parsed payloads and are rebound to the replacement
 * dependency revision the next time they are loaded.
 */
export function invalidateLoadedInputs(
  cache: Map<string, Loaded>,
  changedInputs: ReadonlySet<string>,
): ReadonlySet<string> {
  const invalidatedModules = new Set<string>();
  for (const [cachePath, loaded] of cache) {
    if (loaded.storage.tag === "snapshot") continue;
    let sourceChanged = changedInputs.has(loaded.path);
    if (loaded.storage.tag === "capsule") {
      sourceChanged = changedInputs.has(loaded.storage.path);
    }
    const includeChanged = [...loaded.includedFiles.values()].some(
      (included) => changedInputs.has(included.path),
    );
    if (!sourceChanged && !includeChanged) continue;
    cache.delete(cachePath);
    invalidatedModules.add(loaded.path);
  }
  return invalidatedModules;
}

/**
 * Load a graph, optionally re-resolving cached package edges after input changes.
 * Unchanged resolutions retain their immutable loaded-node and AST identities.
 * Callers using the default must invalidate package resolutions themselves.
 */
export async function load(
  path: string,
  cache: Map<string, Loaded> = modules,
  active: readonly string[] = [],
  inspect?: SourceInspector,
  refreshPackageImports = false,
): Promise<Loaded> {
  const absolute = resolve(path);
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
  const cached = cache.get(absolute);
  if (cached !== undefined) {
    return await rebindLoadedDependencies(
      cached,
      cache,
      nextActive,
      inspect,
      refreshPackageImports,
    );
  }

  if (absolute.endsWith(".blotc")) {
    return await loadModuleCapsule(
      absolute,
      cache,
      active,
      inspect,
      refreshPackageImports,
    );
  }

  const source = await readFile(absolute, "utf8");
  return await loadSourceRevision(
    absolute,
    source,
    cache,
    nextActive,
    false,
    inspect,
    refreshPackageImports,
  );
}

async function rebindLoadedDependencies(
  loaded: Loaded,
  cache: Map<string, Loaded>,
  active: readonly string[],
  inspect: SourceInspector | undefined,
  refreshPackageImports: boolean,
): Promise<Loaded> {
  let changed = false;
  const dependencies = new Map<string, Loaded>();
  for (const [specifier, previous] of loaded.dependencies) {
    let dependency = cache.get(previous.path);
    if (
      dependency === undefined ||
      (refreshPackageImports && isPackageSpecifier(specifier))
    ) {
      let importer = loaded.path;
      if (loaded.storage.tag === "capsule") {
        importer = loaded.storage.path;
      }
      dependency = await loadImport(
        specifier,
        importer,
        cache,
        active,
        inspect,
        refreshPackageImports,
      );
    } else {
      const cycleStart = active.indexOf(dependency.path);
      if (cycleStart >= 0) {
        const cycle = [...active.slice(cycleStart), dependency.path];
        throw new BlotError({
          code: "BLOT_IMPORT_CYCLE",
          message: `Import cycle: ${cycle.join(" -> ")}.`,
          span: { start: 0, end: 0 },
        });
      }
      dependency = await rebindLoadedDependencies(
        dependency,
        cache,
        [...active, dependency.path],
        inspect,
        refreshPackageImports,
      );
    }
    dependencies.set(specifier, dependency);
    if (dependency !== previous) changed = true;
  }
  if (!changed) return loaded;

  const rebound: Loaded = {
    module: loaded.module,
    dependencies,
    includedFiles: loaded.includedFiles,
    source: loaded.source,
    path: loaded.path,
    storage: loaded.storage,
  };
  cache.set(loaded.path, rebound);
  if (
    loaded.storage.tag === "capsule" &&
    cache.get(loaded.storage.path) === loaded
  ) {
    cache.set(loaded.storage.path, rebound);
  }
  return rebound;
}

/** Loads an editor revision without writing it over the source on disk. */
export async function loadSource(
  path: string,
  source: string,
  cache: Map<string, Loaded> = new Map(),
  inspect?: SourceInspector,
  refreshPackageImports = false,
): Promise<Loaded> {
  const absolute = resolve(path);
  return await loadSourceRevision(
    absolute,
    source,
    cache,
    [absolute],
    false,
    inspect,
    refreshPackageImports,
  );
}

/**
 * Loads one internal regression-test revision without source-only validation.
 * Dependencies still use the ordinary checked source path.
 */
export async function loadUncheckedSource(
  path: string,
  source: string,
): Promise<Loaded> {
  const absolute = resolve(path);
  return await loadSourceRevision(
    absolute,
    source,
    new Map(),
    [absolute],
    true,
    undefined,
    false,
  );
}

async function loadSourceRevision(
  absolute: string,
  source: string,
  cache: Map<string, Loaded>,
  active: readonly string[],
  skipSourceValidation: boolean,
  inspect: SourceInspector | undefined,
  refreshPackageImports: boolean,
): Promise<Loaded> {
  const parsed = skipSourceValidation
    ? await parseConcrete(source)
    : await parse(source);
  if (!parsed.ok) {
    throw new LoadError(absolute, source, parsed.diagnostics);
  }

  const dependencySites = dependencyExpressions(parsed.module);
  const invalidIncludePath = dependencySites.invalidIncludePaths[0];
  const inspection = inspect === undefined
    ? undefined
    : await inspect(absolute, source);
  if (invalidIncludePath !== undefined && inspection === undefined) {
    throw new LoadError(absolute, source, [{
      code: "BLOT_INCLUDE_PATH",
      message: "`@include` requires a literal text path.",
      span: invalidIncludePath.span,
    }]);
  }

  const syntaxImports = [...new Set(dependencySites.imports.values())];
  const syntaxIncludes = [...new Set(dependencySites.includes.values())];
  const inspectedImports = inspection?.imports.map((site) => site.specifier);
  const inspectedIncludes = inspection?.includes.map((site) => site.specifier);
  if (inspectedImports !== undefined) {
    requireDependencyParity(
      absolute,
      "imports",
      syntaxImports,
      inspectedImports,
    );
  }
  if (inspectedIncludes !== undefined) {
    requireDependencyParity(
      absolute,
      "includes",
      syntaxIncludes,
      inspectedIncludes,
    );
  }
  const imports = inspectedImports ?? syntaxImports;
  const includes = inspectedIncludes ?? syntaxIncludes;

  const dependencies = new Map<string, Loaded>();
  for (const specifier of new Set(imports)) {
    const dependency = await loadImport(
      specifier,
      absolute,
      cache,
      active,
      inspect,
      refreshPackageImports,
    );
    dependencies.set(specifier, dependency);
  }

  const includedFiles = new Map<string, IncludedFile>();
  for (const specifier of new Set(includes)) {
    let includedPath = specifier;
    if (!isAbsolute(specifier)) {
      includedPath = resolve(dirname(absolute), specifier);
    }
    let includedSource: string;
    try {
      includedSource = await readFile(includedPath, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        const inspectedSite = inspection?.includes.find((site) =>
          site.specifier === specifier
        );
        const syntaxSite = [...dependencySites.includes].find(([, candidate]) =>
          candidate === specifier
        )?.[0];
        throw new LoadError(absolute, source, [{
          code: "BLOT_INCLUDE_NOT_FOUND",
          message: `Included file \`${specifier}\` does not exist.`,
          span: inspectedSite?.span ?? syntaxSite?.span ??
            { start: 0, end: 0 },
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
  }

  const loaded: Loaded = {
    module: parsed.module,
    dependencies,
    includedFiles,
    source,
    path: absolute,
    storage: { tag: "source" },
  };

  cache.set(absolute, loaded);
  return loaded;
}

async function loadImport(
  specifier: string,
  importer: string,
  cache: Map<string, Loaded>,
  active: readonly string[],
  inspect: SourceInspector | undefined,
  refreshPackageImports: boolean,
): Promise<Loaded> {
  if (!isPackageSpecifier(specifier)) {
    return await load(
      resolvePath(specifier, importer),
      cache,
      active,
      inspect,
      refreshPackageImports,
    );
  }
  const exported = await resolvePackageExport(specifier, importer);
  if (exported.built !== undefined) {
    try {
      return await load(
        exported.built,
        cache,
        active,
        inspect,
        refreshPackageImports,
      );
    } catch (error) {
      if (!(error instanceof PackageArtifactError)) throw error;
    }
  }
  try {
    return await load(
      exported.source,
      cache,
      active,
      inspect,
      refreshPackageImports,
    );
  } catch (cause) {
    if (!(isNotFound(cause))) throw cause;
    throw new PackageArtifactError(
      `could not load Blot package ${
        JSON.stringify(exported.packageName)
      } export ${JSON.stringify(exported.exportName)} from source ${
        JSON.stringify(exported.source)
      }`,
      { cause },
    );
  }
}

async function loadModuleCapsule(
  path: string,
  cache: Map<string, Loaded>,
  active: readonly string[],
  inspect: SourceInspector | undefined,
  refreshPackageImports: boolean,
): Promise<Loaded> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (cause) {
    throw new PackageArtifactError(
      `could not read Blot module capsule ${JSON.stringify(path)}`,
      { cause },
    );
  }
  const capsule = await decodeModuleCapsule(source, path);
  const encodedByIdentifier = new Map(
    capsule.modules.map((module) => [module.id, module]),
  );
  const parsedByIdentifier = new Map<string, Module>();
  for (const encoded of capsule.modules) {
    const module = decodePortableModule(
      JSON.parse(encoded.ast),
      `Blot module capsule ${path} module ${encoded.name}`,
    );
    validateCapsuleDependencies(path, encoded, module);
    parsedByIdentifier.set(encoded.id, module);
  }

  const storage: LoadedStorage = { tag: "capsule", path, source };
  const loadedByIdentifier = new Map<string, Loaded>();
  const build = async (
    identifier: string,
    stack: readonly string[],
  ): Promise<Loaded> => {
    const existing = loadedByIdentifier.get(identifier);
    if (existing !== undefined) return existing;
    const cycleStart = stack.indexOf(identifier);
    if (cycleStart >= 0) {
      const cycle = [...stack.slice(cycleStart), identifier];
      throw new PackageArtifactError(
        `Blot module capsule ${JSON.stringify(path)} contains import cycle ${
          cycle.join(" -> ")
        }`,
      );
    }
    const encoded = encodedByIdentifier.get(identifier);
    const module = parsedByIdentifier.get(identifier);
    if (encoded === undefined || module === undefined) {
      throw new Error(`validated module capsule lost ${identifier}`);
    }
    const modulePath = `${path}#${encoded.name}`;
    const cached = cache.get(modulePath);
    if (cached !== undefined) {
      loadedByIdentifier.set(identifier, cached);
      return cached;
    }
    const dependencies = new Map<string, Loaded>();
    const nextStack = [...stack, identifier];
    for (const imported of encoded.imports) {
      let dependency: Loaded;
      if (imported.kind === "bundled") {
        dependency = await build(imported.module, nextStack);
      } else {
        dependency = await loadImport(
          imported.specifier,
          path,
          cache,
          [...active, path],
          inspect,
          refreshPackageImports,
        );
      }
      dependencies.set(imported.specifier, dependency);
    }
    const includedFiles = new Map<string, IncludedFile>();
    for (const included of encoded.includes) {
      includedFiles.set(included.specifier, {
        path: included.path,
        source: included.text,
      });
    }
    const loaded: Loaded = {
      module,
      dependencies,
      includedFiles,
      source: "",
      path: modulePath,
      storage,
    };
    loadedByIdentifier.set(identifier, loaded);
    cache.set(modulePath, loaded);
    return loaded;
  };
  const root = await build(capsule.root, []);
  cache.set(path, root);
  return root;
}

function validateCapsuleDependencies(
  path: string,
  encoded: CapsuleModule,
  module: Module,
): void {
  if (invalidIncludeExpressions(module).length > 0) {
    throw new PackageArtifactError(
      `Blot module capsule ${
        JSON.stringify(path)
      } contains a non-literal include path in ${JSON.stringify(encoded.name)}`,
    );
  }
  const sourceImports = [...new Set(importExpressions(module).values())].sort();
  const capsuleImports = encoded.imports.map((imported) => imported.specifier)
    .sort();
  if (
    sourceImports.length !== capsuleImports.length ||
    sourceImports.some((specifier, index) =>
      specifier !== capsuleImports[index]
    )
  ) {
    throw new PackageArtifactError(
      `Blot module capsule ${JSON.stringify(path)} has import edges for ${
        JSON.stringify(encoded.name)
      } that do not match its source`,
    );
  }
  const sourceIncludes = [...new Set(includeExpressions(module).values())]
    .sort();
  const capsuleIncludes = encoded.includes.map((included) => included.specifier)
    .sort();
  if (
    sourceIncludes.length !== capsuleIncludes.length ||
    sourceIncludes.some((specifier, index) =>
      specifier !== capsuleIncludes[index]
    )
  ) {
    throw new PackageArtifactError(
      `Blot module capsule ${JSON.stringify(path)} has include edges for ${
        JSON.stringify(encoded.name)
      } that do not match its source`,
    );
  }
}

function requireDependencyParity(
  path: string,
  kind: "imports" | "includes",
  syntax: readonly string[],
  inspected: readonly string[],
): void {
  const syntaxSet = [...new Set(syntax)].sort();
  const inspectedSet = [...new Set(inspected)].sort();
  if (
    syntaxSet.length === inspectedSet.length &&
    syntaxSet.every((specifier, index) => specifier === inspectedSet[index])
  ) return;
  throw new Error(
    `${path} ${kind} differ between tooling syntax [${
      syntaxSet.join(", ")
    }] and compiler inspection [${inspectedSet.join(", ")}]`,
  );
}

export function loadedSource(path: string): string | undefined {
  for (const loaded of modules.values()) {
    if (loaded.path === path) return loaded.source;
  }
  return undefined;
}

export { BlotError };

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (!("code" in error)) return false;
  return (error as { readonly code?: unknown }).code === "ENOENT";
}
