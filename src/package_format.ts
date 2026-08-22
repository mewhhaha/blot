import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "@std/path";
import {
  decodePortableModule,
  encodePortableModule,
} from "./syntax/portable.ts";

export const PACKAGE_MANIFEST = "blot.json";
export const PACKAGE_SCHEMA = "blot-package";
export const MODULE_CAPSULE_SCHEMA = "blot-module-capsule";
export const PACKAGE_FORMAT_VERSION = 4;
const CAPSULE_ENCODING = "gzip+json";

export interface PackageExport {
  readonly source: string;
  readonly built?: string;
}

export interface PackageManifest {
  readonly schema: typeof PACKAGE_SCHEMA;
  readonly version: typeof PACKAGE_FORMAT_VERSION;
  readonly exports: ReadonlyMap<string, PackageExport>;
}

export type CapsuleImport =
  | {
    readonly kind: "bundled";
    readonly specifier: string;
    readonly module: string;
  }
  | {
    readonly kind: "external";
    readonly specifier: string;
  };

export interface CapsuleInclude {
  readonly specifier: string;
  readonly path: string;
  readonly text: string;
}

export interface CapsuleModule {
  readonly id: string;
  readonly name: string;
  readonly ast: string;
  readonly imports: readonly CapsuleImport[];
  readonly includes: readonly CapsuleInclude[];
}

export interface ModuleCapsulePayload {
  readonly schema: typeof MODULE_CAPSULE_SCHEMA;
  readonly version: typeof PACKAGE_FORMAT_VERSION;
  readonly root: string;
  readonly modules: readonly CapsuleModule[];
}

export interface ModuleCapsule extends ModuleCapsulePayload {
  readonly hash: string;
}

export interface ResolvedPackageExport {
  readonly packageName: string;
  readonly exportName: string;
  readonly source: string;
  readonly built?: string;
}

export class PackageArtifactError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PackageArtifactError";
  }
}

export async function readPackageManifest(
  manifestPath: string,
): Promise<PackageManifest> {
  let source: string;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (cause) {
    throw new PackageArtifactError(
      `could not read Blot package manifest ${JSON.stringify(manifestPath)}`,
      { cause },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new PackageArtifactError(
      `Blot package manifest ${JSON.stringify(manifestPath)} is not valid JSON`,
      { cause },
    );
  }
  const manifest = record(parsed, `Blot package manifest ${manifestPath}`);
  if (manifest.schema !== PACKAGE_SCHEMA) {
    throw new PackageArtifactError(
      `Blot package manifest ${JSON.stringify(manifestPath)} has schema ${
        JSON.stringify(manifest.schema)
      }, expected ${JSON.stringify(PACKAGE_SCHEMA)}`,
    );
  }
  if (manifest.version !== PACKAGE_FORMAT_VERSION) {
    throw new PackageArtifactError(
      `Blot package manifest ${JSON.stringify(manifestPath)} has version ${
        JSON.stringify(manifest.version)
      }, expected ${PACKAGE_FORMAT_VERSION}`,
    );
  }
  const encodedExports = record(
    manifest.exports,
    `exports in Blot package manifest ${manifestPath}`,
  );
  const exports = new Map<string, PackageExport>();
  for (const [name, encoded] of Object.entries(encodedExports)) {
    if (
      name !== "." &&
      (!name.startsWith("./") ||
        name.slice(2).split("/").some((segment) => segment.length === 0))
    ) {
      throw new PackageArtifactError(
        `Blot package manifest ${
          JSON.stringify(manifestPath)
        } has invalid export ${
          JSON.stringify(name)
        }; expected "." or a name beginning with "./"`,
      );
    }
    const entry = record(
      encoded,
      `export ${JSON.stringify(name)} in Blot package manifest ${manifestPath}`,
    );
    const sourceTarget = text(
      entry.source,
      `source target for export ${JSON.stringify(name)} in ${manifestPath}`,
    );
    const builtTarget = optionalText(
      entry.built,
      `built target for export ${JSON.stringify(name)} in ${manifestPath}`,
    );
    if (builtTarget !== undefined && !builtTarget.endsWith(".blotc")) {
      throw new PackageArtifactError(
        `built target for export ${JSON.stringify(name)} in ${
          JSON.stringify(manifestPath)
        } must end with ".blotc", found ${JSON.stringify(builtTarget)}`,
      );
    }
    const packageRoot = dirname(manifestPath);
    const source = confinedTarget(
      packageRoot,
      sourceTarget,
      manifestPath,
      name,
    );
    let built: string | undefined;
    if (builtTarget !== undefined) {
      built = confinedTarget(packageRoot, builtTarget, manifestPath, name);
    }
    exports.set(name, { source, built });
  }
  if (exports.size === 0) {
    throw new PackageArtifactError(
      `Blot package manifest ${JSON.stringify(manifestPath)} exports nothing`,
    );
  }
  return { schema: PACKAGE_SCHEMA, version: PACKAGE_FORMAT_VERSION, exports };
}

export async function resolvePackageExport(
  specifier: string,
  importer: string,
): Promise<ResolvedPackageExport> {
  const parsed = packageSpecifier(specifier);
  let directory = dirname(importer);
  while (true) {
    const packageRoot = resolve(directory, "node_modules", parsed.packageName);
    const manifestPath = resolve(packageRoot, PACKAGE_MANIFEST);
    try {
      const manifest = await readPackageManifest(manifestPath);
      const exported = manifest.exports.get(parsed.exportName);
      if (exported === undefined) {
        throw new PackageArtifactError(
          `Blot package ${JSON.stringify(parsed.packageName)} does not export ${
            JSON.stringify(parsed.exportName)
          } in ${JSON.stringify(manifestPath)}`,
        );
      }
      return {
        packageName: parsed.packageName,
        exportName: parsed.exportName,
        source: exported.source,
        built: exported.built,
      };
    } catch (error) {
      if (
        error instanceof PackageArtifactError &&
        isNotFound(error.cause)
      ) {
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
        continue;
      }
      throw error;
    }
  }
  throw new PackageArtifactError(
    `could not resolve Blot package ${
      JSON.stringify(parsed.packageName)
    } from ${
      JSON.stringify(importer)
    }; no ${PACKAGE_MANIFEST} was found in an enclosing node_modules directory`,
  );
}

export function isPackageSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !isAbsolute(specifier) &&
    !specifier.includes(":");
}

export async function encodeModuleCapsule(
  payload: ModuleCapsulePayload,
): Promise<string> {
  const normalized = normalizePayload(
    payload,
    "module capsule payload",
    portableAst,
  );
  const compressed = await gzip(
    new TextEncoder().encode(canonicalPayload(normalized)),
  );
  const hash = await contentHash(compressed);
  return `${
    JSON.stringify({
      schema: MODULE_CAPSULE_SCHEMA,
      version: PACKAGE_FORMAT_VERSION,
      encoding: CAPSULE_ENCODING,
      payload: compressed.toBase64(),
      hash,
    })
  }\n`;
}

export async function decodeModuleCapsule(
  source: string,
  path: string,
): Promise<ModuleCapsule> {
  return await decodeCapsule(source, path, portableAst);
}

export async function decodeModuleCapsuleForRust(
  source: string,
  path: string,
): Promise<ModuleCapsule> {
  return await decodeCapsule(source, path, portableAstEnvelope);
}

async function decodeCapsule(
  source: string,
  path: string,
  normalizeAst: (encoded: unknown, location: string) => string,
): Promise<ModuleCapsule> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new PackageArtifactError(
      `Blot module capsule ${JSON.stringify(path)} is not valid JSON`,
      { cause },
    );
  }
  const encoded = record(parsed, `Blot module capsule ${path}`);
  if (encoded.schema !== MODULE_CAPSULE_SCHEMA) {
    throw new PackageArtifactError(
      `Blot module capsule ${JSON.stringify(path)} has schema ${
        JSON.stringify(encoded.schema)
      }, expected ${JSON.stringify(MODULE_CAPSULE_SCHEMA)}`,
    );
  }
  if (encoded.version !== PACKAGE_FORMAT_VERSION) {
    throw new PackageArtifactError(
      `Blot module capsule ${JSON.stringify(path)} has version ${
        JSON.stringify(encoded.version)
      }, expected ${PACKAGE_FORMAT_VERSION}`,
    );
  }
  if (encoded.encoding !== CAPSULE_ENCODING) {
    throw new PackageArtifactError(
      `Blot module capsule ${JSON.stringify(path)} has encoding ${
        JSON.stringify(encoded.encoding)
      }, expected ${JSON.stringify(CAPSULE_ENCODING)}`,
    );
  }
  const encodedPayload = text(
    encoded.payload,
    `payload in Blot module capsule ${path}`,
  );
  let compressed: Uint8Array;
  try {
    compressed = Uint8Array.fromBase64(encodedPayload);
  } catch (cause) {
    throw new PackageArtifactError(
      `Blot module capsule ${JSON.stringify(path)} payload is not base64`,
      { cause },
    );
  }
  const hash = text(
    encoded.hash,
    `content hash in Blot module capsule ${path}`,
  );
  const expected = await contentHash(compressed);
  if (hash !== expected) {
    throw new PackageArtifactError(
      `Blot module capsule ${JSON.stringify(path)} has content hash ${
        JSON.stringify(hash)
      }, expected ${JSON.stringify(expected)}`,
    );
  }
  let payload: unknown;
  try {
    const bytes = await gunzip(compressed);
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (cause) {
    throw new PackageArtifactError(
      `Blot module capsule ${
        JSON.stringify(path)
      } payload is not valid gzip JSON`,
      { cause },
    );
  }
  const normalized = normalizePayload(
    payload,
    `Blot module capsule ${path}`,
    normalizeAst,
  );
  return { ...normalized, hash };
}

function normalizePayload(
  encoded: unknown,
  location: string,
  normalizeAst: (
    encoded: unknown,
    location: string,
  ) => string,
): ModuleCapsulePayload {
  const payload = record(encoded, location);
  if (payload.schema !== MODULE_CAPSULE_SCHEMA) {
    throw new PackageArtifactError(
      `${location} has schema ${JSON.stringify(payload.schema)}, expected ${
        JSON.stringify(MODULE_CAPSULE_SCHEMA)
      }`,
    );
  }
  if (payload.version !== PACKAGE_FORMAT_VERSION) {
    throw new PackageArtifactError(
      `${location} has version ${
        JSON.stringify(payload.version)
      }, expected ${PACKAGE_FORMAT_VERSION}`,
    );
  }
  const root = text(payload.root, `root in ${location}`);
  const modules = list(payload.modules, `modules in ${location}`).map(
    (value, ordinal) =>
      normalizeModule(value, `${location} module ${ordinal}`, normalizeAst),
  ).sort((left, right) => left.id.localeCompare(right.id));
  const identifiers = new Set<string>();
  const names = new Set<string>();
  for (const module of modules) {
    if (identifiers.has(module.id)) {
      throw new PackageArtifactError(
        `${location} repeats module identifier ${JSON.stringify(module.id)}`,
      );
    }
    identifiers.add(module.id);
    if (names.has(module.name)) {
      throw new PackageArtifactError(
        `${location} repeats module name ${JSON.stringify(module.name)}`,
      );
    }
    names.add(module.name);
  }
  if (!identifiers.has(root)) {
    throw new PackageArtifactError(
      `${location} names missing root module ${JSON.stringify(root)}`,
    );
  }
  for (const module of modules) {
    for (const imported of module.imports) {
      if (imported.kind === "bundled" && !identifiers.has(imported.module)) {
        throw new PackageArtifactError(
          `${location} module ${
            JSON.stringify(module.id)
          } imports missing module ${JSON.stringify(imported.module)} for ${
            JSON.stringify(imported.specifier)
          }`,
        );
      }
    }
  }
  return {
    schema: MODULE_CAPSULE_SCHEMA,
    version: PACKAGE_FORMAT_VERSION,
    root,
    modules,
  };
}

function normalizeModule(
  value: unknown,
  location: string,
  normalizeAst: (encoded: unknown, location: string) => string,
): CapsuleModule {
  const module = record(value, location);
  const id = text(module.id, `identifier in ${location}`);
  const name = text(module.name, `name in ${location}`);
  const ast = normalizeAst(module.ast, `${location} portable AST`);
  const imports = list(module.imports, `imports in ${location}`).map(
    (value, ordinal) => {
      const imported = record(value, `${location} import ${ordinal}`);
      const specifier = text(
        imported.specifier,
        `specifier in ${location} import ${ordinal}`,
      );
      if (imported.kind === "external") {
        return { kind: "external" as const, specifier };
      }
      if (imported.kind === "bundled") {
        return {
          kind: "bundled" as const,
          specifier,
          module: text(
            imported.module,
            `module identifier in ${location} import ${ordinal}`,
          ),
        };
      }
      throw new PackageArtifactError(
        `${location} import ${ordinal} has invalid kind ${
          JSON.stringify(imported.kind)
        }`,
      );
    },
  );
  rejectRepeated(
    imports.map((imported) => imported.specifier),
    `${location} import specifier`,
  );
  const includes = list(module.includes, `includes in ${location}`).map(
    (value, ordinal) => {
      const included = record(value, `${location} include ${ordinal}`);
      return {
        specifier: text(
          included.specifier,
          `specifier in ${location} include ${ordinal}`,
        ),
        path: text(included.path, `path in ${location} include ${ordinal}`),
        text: stringValue(
          included.text,
          `text in ${location} include ${ordinal}`,
        ),
      };
    },
  );
  rejectRepeated(
    includes.map((included) => included.specifier),
    `${location} include specifier`,
  );
  imports.sort((left, right) => left.specifier.localeCompare(right.specifier));
  includes.sort((left, right) => left.specifier.localeCompare(right.specifier));
  return { id, name, ast, imports, includes };
}

function portableAst(encoded: unknown, location: string): string {
  const source = text(encoded, location);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new PackageArtifactError(`${location} is not valid JSON`, { cause });
  }
  try {
    return JSON.stringify(
      encodePortableModule(decodePortableModule(parsed, location)),
    );
  } catch (cause) {
    throw new PackageArtifactError(
      `${location} is not valid`,
      { cause },
    );
  }
}

function portableAstEnvelope(
  encoded: unknown,
  location: string,
): string {
  return text(encoded, location);
}

function canonicalPayload(payload: ModuleCapsulePayload): string {
  return JSON.stringify({
    schema: payload.schema,
    version: payload.version,
    root: payload.root,
    modules: payload.modules.map((module) => ({
      id: module.id,
      name: module.name,
      ast: module.ast,
      imports: [...module.imports].sort((left, right) =>
        left.specifier.localeCompare(right.specifier)
      ),
      includes: [...module.includes].sort((left, right) =>
        left.specifier.localeCompare(right.specifier)
      ),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  });
}

async function contentHash(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  const hexadecimal = [...digest].map((byte) =>
    byte.toString(16).padStart(2, "0")
  )
    .join("");
  return `sha256:${hexadecimal}`;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const compressed = new Blob([Uint8Array.from(bytes).buffer]).stream()
    .pipeThrough(
      new CompressionStream("gzip"),
    );
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const decompressed = new Blob([Uint8Array.from(bytes).buffer]).stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(decompressed).arrayBuffer());
}

function packageSpecifier(specifier: string): {
  readonly packageName: string;
  readonly exportName: string;
} {
  if (!isPackageSpecifier(specifier)) {
    throw new PackageArtifactError(
      `${JSON.stringify(specifier)} is not a bare Blot package specifier`,
    );
  }
  const segments = specifier.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new PackageArtifactError(
      `${JSON.stringify(specifier)} is not a valid Blot package specifier`,
    );
  }
  let packageSegments = 1;
  if (specifier.startsWith("@")) packageSegments = 2;
  if (
    segments.length < packageSegments ||
    segments.slice(0, packageSegments).some((segment) => segment.length === 0)
  ) {
    throw new PackageArtifactError(
      `${JSON.stringify(specifier)} is not a valid Blot package specifier`,
    );
  }
  const packageName = segments.slice(0, packageSegments).join("/");
  const subpath = segments.slice(packageSegments).join("/");
  let exportName = ".";
  if (subpath.length > 0) exportName = `./${subpath}`;
  return { packageName, exportName };
}

function confinedTarget(
  packageRoot: string,
  target: string,
  manifestPath: string,
  exportName: string,
): string {
  if (isAbsolute(target)) {
    throw new PackageArtifactError(
      `export ${JSON.stringify(exportName)} in ${
        JSON.stringify(manifestPath)
      } uses absolute target ${JSON.stringify(target)}`,
    );
  }
  const absolute = resolve(packageRoot, target);
  const pathFromRoot = relative(packageRoot, absolute);
  if (
    pathFromRoot === ".." || pathFromRoot.startsWith("../") ||
    pathFromRoot.startsWith("..\\")
  ) {
    throw new PackageArtifactError(
      `export ${JSON.stringify(exportName)} in ${
        JSON.stringify(manifestPath)
      } escapes its package with target ${JSON.stringify(target)}`,
    );
  }
  return absolute;
}

function rejectRepeated(values: readonly string[], location: string): void {
  const found = new Set<string>();
  for (const value of values) {
    if (found.has(value)) {
      throw new PackageArtifactError(
        `${location} repeats ${JSON.stringify(value)}`,
      );
    }
    found.add(value);
  }
}

function record(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PackageArtifactError(`${location} is not an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, location: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new PackageArtifactError(`${location} is not an array`);
  }
  return value;
}

function text(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PackageArtifactError(`${location} is not non-empty text`);
  }
  return value;
}

function optionalText(value: unknown, location: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, location);
}

function stringValue(value: unknown, location: string): string {
  if (typeof value !== "string") {
    throw new PackageArtifactError(`${location} is not text`);
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (!("code" in error)) return false;
  return (error as { readonly code?: unknown }).code === "ENOENT";
}
