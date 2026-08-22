import { assertEquals } from "@std/assert";
import { resolve } from "@std/path";
import { prepareGpupaperHir } from "../../src/conformance/gpufuck/compile.ts";
import {
  type BlotRuntimeModule,
  validateBlotRuntimeModule,
} from "../../src/runtime/hir.ts";
import { buildBlotAbiManifest } from "../../src/compiler/backend/runtime/abi.ts";
import { load, type Loaded } from "../../src/load.ts";
import { CompilerWasm } from "../../src/compiler/wasm.ts";

const wasm = await Deno.readFile(
  new URL("../../generated/compiler/compiler.wasm", import.meta.url),
);
const rust = await CompilerWasm.load(wasm);
let roots = Deno.args;
if (roots.length === 0) roots = await repositoryPrograms();
const expectedTargetRefusals = new Set([
  "examples/capabilities.blot",
  "examples/projected.blot",
  "examples/simd.blot",
  "examples/tour.blot",
]);
{
  const failures: { readonly root: string; readonly message: string }[] = [];
  const oracleRejections: {
    readonly root: string;
    readonly message: string;
  }[] = [];
  const targetRefusals: {
    readonly root: string;
    readonly message: string;
  }[] = [];
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
        if (prepared.targetRefusal !== undefined) {
          if (!expectedTargetRefusals.has(root)) {
            throw new Error(
              `${prepared.targetRefusal.code}: ${prepared.targetRefusal.message}`,
            );
          }
          targetRefusals.push({
            root,
            message: prepared.targetRefusal.message,
          });
          continue;
        }
        let code: string | undefined;
        let message: string | undefined;
        if (prepared.invariantFailure !== undefined) {
          code = prepared.invariantFailure.code;
          message =
            `${prepared.invariantFailure.phase}: ${prepared.invariantFailure.message}`;
        }
        if (code === undefined) code = prepared.diagnostic?.code;
        if (message === undefined) message = prepared.diagnostic?.message;
        if (code === undefined) code = "RUST_HIR_ERROR";
        if (message === undefined) message = prepared.message;
        throw new Error(
          `${code}: ${message}`,
        );
      }
      if (typescriptError !== undefined) {
        oracleRejections.push({
          root,
          message: errorMessage(typescriptError),
        });
        continue;
      }
      if (typescriptModule === undefined) {
        throw new Error(
          `${root}: TypeScript HIR preparation returned no result`,
        );
      }
      const rustModule = validateBlotRuntimeModule(prepared.module);
      const validatedTypescriptModule = validateBlotRuntimeModule(
        typescriptModule,
      );
      if (root.endsWith("owned_slice_quicksort.blot")) {
        const expected = { recursiveCalls: 2, backEdges: 2 };
        assertEquals(
          quicksortTailShape(rustModule),
          expected,
          `${root}: Rust smaller-first recursion`,
        );
        assertEquals(
          quicksortTailShape(validatedTypescriptModule),
          expected,
          `${root}: TypeScript smaller-first recursion`,
        );
      }
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
    JSON.stringify(
      {
        compared,
        mutualRejections,
        targetRefusals,
        oracleRejections,
        failures,
      },
      null,
      2,
    ),
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

function quicksortTailShape(module: BlotRuntimeModule): {
  readonly recursiveCalls: number;
  readonly backEdges: number;
} {
  const recursive = module.functions.find((function_) =>
    function_.blocks.some((block) =>
      block.operations.some((operation) =>
        operation.kind === "call.direct" &&
        operation.function === function_.id
      )
    )
  );
  if (recursive === undefined) {
    throw new Error(`${module.source}: quicksort recursive function is absent`);
  }
  const recursiveCalls = recursive.blocks.flatMap((block) => block.operations)
    .filter((operation) =>
      operation.kind === "call.direct" &&
      operation.function === recursive.id
    ).length;
  const backEdges =
    recursive.blocks.filter((block) =>
      block.terminator.kind === "branch" &&
      block.terminator.target === recursive.entryBlock
    ).length;
  return { recursiveCalls, backEdges };
}

function collect(loaded: Loaded, modules: Map<string, Loaded>): void {
  if (modules.has(loaded.path)) return;
  modules.set(loaded.path, loaded);
  for (const dependency of loaded.dependencies.values()) {
    collect(dependency, modules);
  }
}

async function repositoryPrograms(): Promise<string[]> {
  const paths = ["experiments/owned-regions/owned_slice_quicksort.blot"];
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
