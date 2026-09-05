import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "@std/path";
import { compareCodeUnits } from "./text_order.ts";
import { Compiler } from "./compiler/session.ts";
import { load, type Loaded, refreshLoadedModules } from "./load.ts";
import {
  encodeModuleCapsule,
  MODULE_CAPSULE_SCHEMA,
  type ModuleCapsulePayload,
  PACKAGE_FORMAT_VERSION,
  readPackageManifest,
} from "./package_format.ts";

export interface BuiltPackageExport {
  readonly name: string;
  readonly source: string;
  readonly built: string;
  readonly bytes: number;
  readonly modules: number;
}

export async function buildPackage(
  manifestPath: string,
): Promise<readonly BuiltPackageExport[]> {
  const absoluteManifest = resolve(manifestPath);
  const packageRoot = dirname(absoluteManifest);
  const manifest = await readPackageManifest(absoluteManifest);
  await refreshLoadedModules();
  const compiler = await Compiler.create();
  const prepared: Array<BuiltPackageExport & { readonly contents: string }> =
    [];
  const builtTargets = new Set<string>();
  try {
    for (
      const [name, exported] of [...manifest.exports].sort(([left], [right]) =>
        compareCodeUnits(left, right)
      )
    ) {
      if (exported.built === undefined) {
        throw new Error(
          `Blot package export ${JSON.stringify(name)} in ${
            JSON.stringify(absoluteManifest)
          } has no built target`,
        );
      }
      if (builtTargets.has(exported.built)) {
        throw new Error(
          `Blot package manifest ${
            JSON.stringify(absoluteManifest)
          } repeats built target ${JSON.stringify(exported.built)}`,
        );
      }
      builtTargets.add(exported.built);
      await compiler.check(exported.source);
      const asts = await compiler.portableGraph(exported.source);
      const root = await load(exported.source, undefined, [], undefined, true);
      const payload = moduleCapsule(root, packageRoot, exported.source, asts);
      const source = await encodeModuleCapsule(payload);
      prepared.push({
        name,
        source: exported.source,
        built: exported.built,
        bytes: new TextEncoder().encode(source).byteLength,
        modules: payload.modules.length,
        contents: source,
      });
    }
  } finally {
    compiler.destroy();
  }
  for (const artifact of prepared) {
    await mkdir(dirname(artifact.built), { recursive: true });
    await writeFile(artifact.built, artifact.contents, "utf8");
  }
  return prepared.map(({ contents: _contents, ...artifact }) => artifact);
}

function moduleCapsule(
  root: Loaded,
  packageRoot: string,
  rootSource: string,
  asts: ReadonlyMap<string, string>,
): ModuleCapsulePayload {
  const ordered: Loaded[] = [];
  const identifiers = new Map<Loaded, string>();
  const names = new Map<Loaded, string>();
  names.set(root, packageRelativeName(packageRoot, rootSource));

  const visit = (loaded: Loaded): void => {
    if (identifiers.has(loaded)) return;
    const identifier = `m${ordered.length}`;
    identifiers.set(loaded, identifier);
    ordered.push(loaded);
    if (!names.has(loaded)) {
      throw new Error(
        `package graph module ${loaded.path} has no logical name`,
      );
    }
    for (
      const [specifier, dependency] of [...loaded.dependencies].sort(
        ([left], [right]) => compareCodeUnits(left, right),
      )
    ) {
      if (isAbsolute(specifier)) {
        throw new Error(
          `package module ${
            JSON.stringify(loaded.path)
          } imports absolute path ${
            JSON.stringify(specifier)
          }, which has no portable package identity`,
        );
      }
      if (!specifier.startsWith(".")) continue;
      if (!names.has(dependency)) {
        names.set(
          dependency,
          packageRelativeName(packageRoot, dependency.path),
        );
      }
      visit(dependency);
    }
  };
  visit(root);

  const modules = ordered.map((loaded) => {
    const id = identifiers.get(loaded);
    const name = names.get(loaded);
    if (id === undefined || name === undefined) {
      throw new Error(`package graph lost module ${loaded.path}`);
    }
    const imports = [...loaded.dependencies].map(([specifier, dependency]) => {
      const module = identifiers.get(dependency);
      if (module === undefined) {
        return { kind: "external" as const, specifier };
      }
      return { kind: "bundled" as const, specifier, module };
    });
    const includes = [...loaded.includedFiles].map(([specifier, included]) => {
      if (loaded.storage.tag === "capsule") {
        return { specifier, path: included.path, text: included.source };
      }
      let path = relative(dirname(loaded.path), included.path).replaceAll(
        "\\",
        "/",
      );
      if (!path.startsWith(".")) path = `./${path}`;
      return { specifier, path, text: included.source };
    });
    const ast = asts.get(loaded.path);
    if (ast === undefined) {
      throw new Error(`Rust compiler omitted portable AST for ${loaded.path}`);
    }
    return {
      id,
      name,
      ast,
      imports,
      includes,
    };
  });
  const rootIdentifier = identifiers.get(root);
  if (rootIdentifier === undefined) {
    throw new Error(`package graph lost root module ${root.path}`);
  }
  return {
    schema: MODULE_CAPSULE_SCHEMA,
    version: PACKAGE_FORMAT_VERSION,
    root: rootIdentifier,
    modules,
  };
}

function packageRelativeName(packageRoot: string, path: string): string {
  const fromRoot = relative(packageRoot, path).replaceAll("\\", "/");
  if (fromRoot.length === 0) return ".";
  if (fromRoot !== ".." && !fromRoot.startsWith("../")) {
    return `./${fromRoot}`;
  }
  throw new Error(
    `package-owned module ${JSON.stringify(path)} is outside ${
      JSON.stringify(packageRoot)
    }`,
  );
}
