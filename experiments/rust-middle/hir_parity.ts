import { assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import { prepareGpupaperHir } from "../../src/backend/compile.ts";
import {
  type BlotRuntimeModule,
  validateBlotRuntimeModule,
} from "../../src/backend/runtime/hir.ts";
import { buildBlotAbiManifest } from "../../src/backend/runtime/abi.ts";
import { load, type Loaded } from "../../src/load.ts";
import { RustMiddle } from "../../src/backend/rust_middle_wasm.ts";

const wasm = await Deno.readFile(
  new URL("../../generated/rust-middle/compiler.wasm", import.meta.url),
);
const rust = await RustMiddle.load(wasm);
let roots = Deno.args;
if (roots.length === 0) roots = await repositoryPrograms();
{
  const failures: { readonly root: string; readonly message: string }[] = [];
  let compared = 0;
  let mutualRejections = 0;
  for (const root of roots) {
    const session = rust.createCompilerSession();
    try {
      const path = resolve(root);
      const loadedModules = new Map<string, Loaded>();
      collect(await load(path), loadedModules);
      for (const loaded of loadedModules.values()) {
        const added = rust.addCompilerSessionModule(
          session,
          loaded.path,
          loaded.source,
        );
        if (!added.ok) throw new Error(`${loaded.path}: ${added.message}`);
      }
      for (const loaded of loadedModules.values()) {
        rust.configureCompilerSessionModule(session, loaded.path, {
          imports: Object.fromEntries(
            [...loaded.dependencies].map(([specifier, dependency]) => [
              specifier,
              dependency.path,
            ]),
          ),
          includes: Object.fromEntries(
            [...loaded.includedFiles].map(([specifier, included]) => [
              specifier,
              { path: included.path, text: included.source },
            ]),
          ),
        });
      }
      const prepared = rust.prepareCompilerSessionRuntimeHir(session, path);
      let typescriptModule: BlotRuntimeModule | undefined;
      let typescriptError: unknown;
      try {
        typescriptModule = await prepareGpupaperHir(path);
      } catch (error) {
        typescriptError = error;
      }
      if (!prepared.ok) {
        if (typescriptError !== undefined) {
          mutualRejections += 1;
          continue;
        }
        let code = prepared.diagnostic?.code;
        if (code === undefined) code = "RUST_HIR_ERROR";
        let message = prepared.diagnostic?.message;
        if (message === undefined) message = prepared.message;
        throw new Error(
          `${code}: ${message}`,
        );
      }
      if (typescriptError !== undefined) throw typescriptError;
      if (typescriptModule === undefined) {
        throw new Error(
          `${root}: TypeScript HIR preparation returned no result`,
        );
      }
      const rustModule = validateBlotRuntimeModule(prepared.module);
      const validatedTypescriptModule = validateBlotRuntimeModule(
        typescriptModule,
      );
      assertEquals(
        exportedPhases(rustModule),
        exportedPhases(validatedTypescriptModule),
        `${root}: staged exports`,
      );
      assertEquals(
        buildBlotAbiManifest(rustModule),
        buildBlotAbiManifest(validatedTypescriptModule),
        `${root}: ABI manifest`,
      );
      compared += 1;
    } catch (error) {
      failures.push({
        root,
        message: errorMessage(error),
      });
    } finally {
      rust.destroyCompilerSession(session);
    }
  }
  console.log(
    JSON.stringify({ compared, mutualRejections, failures }, null, 2),
  );
  if (failures.length > 0) Deno.exitCode = 1;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function exportedPhases(module: BlotRuntimeModule): readonly string[] {
  return module.exports.map((exported) =>
    `${exported.sourceName}:${exported.phase}`
  );
}

function collect(loaded: Loaded, modules: Map<string, Loaded>): void {
  if (modules.has(loaded.path)) return;
  modules.set(loaded.path, loaded);
  for (const dependency of loaded.dependencies.values()) {
    collect(dependency, modules);
  }
}

async function repositoryPrograms(): Promise<string[]> {
  const paths: string[] = [];
  for (const directory of ["examples", "case-studies"]) {
    for await (const entry of walk(directory)) {
      if (
        entry.endsWith(".blot") && !entry.includes("/rejected/")
      ) {
        paths.push(entry);
      }
    }
  }
  return paths.sort();
}

async function* walk(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walk(path);
    } else if (entry.isFile) {
      yield path;
    }
  }
}
