import { assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import { prepareGpupaperHir } from "../../src/backend/compile.ts";
import { RustMiddleCompiler } from "../../src/backend/rust_middle.ts";
import { validateBlotRuntimeModule } from "../../src/backend/runtime/hir.ts";
import { compileBlotRuntimeModulesOnRustWasm } from "../../src/backend/runtime/target.ts";
import { checkFile } from "../../src/check/mod.ts";
import { refreshLoadedModules } from "../../src/load.ts";

let sourcePath = "examples/storage.blot";
if (Deno.args[0] !== undefined) sourcePath = Deno.args[0];
const samples = 9;
const compilerBytes = await Deno.readFile(
  new URL("../../generated/rust-middle/compiler.wasm", import.meta.url),
);
const compilerArtifactSha256 = [
  ...new Uint8Array(
    await crypto.subtle.digest("SHA-256", compilerBytes),
  ),
].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const typescriptColdStarted = performance.now();
const typescriptArtifact = await compileTypescript(sourcePath);
const typescriptCold = performance.now() - typescriptColdStarted;

const rustInstantiationStarted = performance.now();
const rust = await RustMiddleCompiler.create();
const rustInstantiation = performance.now() - rustInstantiationStarted;
try {
  const rustColdStarted = performance.now();
  const rustArtifact = await rust.compile(sourcePath);
  const rustCold = performance.now() - rustColdStarted;

  assertEquals(
    rustArtifact.manifestBytes,
    typescriptArtifact.manifestBytes,
    "the two compilers must publish the same ABI before timing is meaningful",
  );

  const typescriptResident = await median(samples, async () => {
    await compileTypescript(sourcePath);
  });
  const rustResident = await median(samples, async () => {
    await rust.compile(sourcePath);
  });
  const typescriptCheck = await median(samples, async () => {
    await checkFile(sourcePath);
  });
  const rustCheck = await median(samples, async () => {
    await rust.check(sourcePath);
  });

  const sourceOnlyIncremental = await incrementalTimes(
    rust,
    sourcePath,
    samples,
    editedComment,
  );
  const changedModuleIncremental = await incrementalTimes(
    rust,
    sourcePath,
    samples,
    editedModule,
  );
  const changedModulePhases = await incrementalPhaseTimes(
    rust,
    sourcePath,
    samples,
  );
  console.log(JSON.stringify(
    {
      source: sourcePath,
      samples,
      compiler_artifact_sha256: compilerArtifactSha256,
      wasm_bytes: {
        typescript_gpupaper: typescriptArtifact.wasm.byteLength,
        full_rust: rustArtifact.wasm.byteLength,
      },
      milliseconds: {
        typescript_gpupaper_cold: typescriptCold,
        rust_wasm_instantiation: rustInstantiation,
        full_rust_cold_after_instantiation: rustCold,
        typescript_gpupaper_resident: typescriptResident,
        full_rust_resident: rustResident,
        typescript_resident_check: typescriptCheck,
        rust_resident_check: rustCheck,
        typescript_source_only_edit: sourceOnlyIncremental.typescript,
        rust_source_only_edit: sourceOnlyIncremental.rust,
        typescript_changed_module_edit: changedModuleIncremental.typescript,
        rust_changed_module_edit: changedModuleIncremental.rust,
        typescript_cold_end_to_end: typescriptCold,
        rust_cold_end_to_end: rustInstantiation + rustCold,
      },
      end_to_end_speedup: {
        cold_after_instantiation: typescriptCold / rustCold,
        resident: typescriptResident / rustResident,
        source_only_edit: sourceOnlyIncremental.typescript /
          sourceOnlyIncremental.rust,
        changed_module_edit: changedModuleIncremental.typescript /
          changedModuleIncremental.rust,
      },
      checker_share_of_incremental: {
        typescript: typescriptCheck / changedModuleIncremental.typescript,
        rust: rustCheck / changedModuleIncremental.rust,
      },
      rust_changed_module_phases: changedModulePhases,
    },
    null,
    2,
  ));
} finally {
  rust.destroy();
}

async function incrementalTimes(
  rust: RustMiddleCompiler,
  measuredSourcePath: string,
  sampleCount: number,
  edit: (source: string, revision: number) => string,
): Promise<{ readonly typescript: number; readonly rust: number }> {
  const source = await Deno.readTextFile(measuredSourcePath);
  const directory = dirname(measuredSourcePath);
  const typescriptPath = await Deno.makeTempFile({
    dir: directory,
    prefix: ".blot-benchmark-typescript-",
    suffix: ".blot",
  });
  const rustPath = await Deno.makeTempFile({
    dir: directory,
    prefix: ".blot-benchmark-rust-",
    suffix: ".blot",
  });
  try {
    await Deno.writeTextFile(typescriptPath, edit(source, 0));
    await Deno.writeTextFile(rustPath, edit(source, 0));
    await compileTypescript(typescriptPath);
    await rust.compile(rustPath);
    let revision = 1;
    const typescript = await median(sampleCount, async () => {
      await Deno.writeTextFile(
        typescriptPath,
        edit(source, revision),
      );
      revision += 1;
      await compileTypescript(typescriptPath);
    });
    revision = 1;
    const rustTime = await median(sampleCount, async () => {
      await Deno.writeTextFile(rustPath, edit(source, revision));
      revision += 1;
      await rust.compile(rustPath);
    });
    return { typescript, rust: rustTime };
  } finally {
    await Deno.remove(typescriptPath);
    await Deno.remove(rustPath);
  }
}

async function incrementalPhaseTimes(
  rust: RustMiddleCompiler,
  measuredSourcePath: string,
  sampleCount: number,
): Promise<{
  readonly check: number;
  readonly prepare_after_check: number;
  readonly compile_after_prepare: number;
}> {
  const source = await Deno.readTextFile(measuredSourcePath);
  const path = await Deno.makeTempFile({
    dir: dirname(measuredSourcePath),
    prefix: ".blot-benchmark-phases-",
    suffix: ".blot",
  });
  const checks: number[] = [];
  const preparations: number[] = [];
  const compilations: number[] = [];
  try {
    await Deno.writeTextFile(path, editedModule(source, 0));
    await rust.compile(path);
    for (let revision = 1; revision <= sampleCount; revision += 1) {
      await Deno.writeTextFile(path, editedModule(source, revision));
      const checkStarted = performance.now();
      await rust.check(path);
      checks.push(performance.now() - checkStarted);

      const prepareStarted = performance.now();
      await rust.prepare(path);
      preparations.push(performance.now() - prepareStarted);

      const compileStarted = performance.now();
      await rust.compile(path);
      compilations.push(performance.now() - compileStarted);
    }
  } finally {
    await Deno.remove(path);
  }
  return {
    check: medianValue(checks),
    prepare_after_check: medianValue(preparations),
    compile_after_prepare: medianValue(compilations),
  };
}

function editedComment(source: string, revision: number): string {
  return `${source}\n// benchmark source revision ${revision}\n`;
}

function editedModule(source: string, revision: number): string {
  const returnStart = source.lastIndexOf("\nreturn ");
  if (returnStart < 0) {
    throw new Error("benchmark source has no top-level return declaration");
  }
  const insertion = `\nlet benchmark_revision = ${revision};`;
  return source.slice(0, returnStart) + insertion + source.slice(returnStart);
}

async function compileTypescript(path: string) {
  await refreshLoadedModules();
  const hir = validateBlotRuntimeModule(await prepareGpupaperHir(path));
  const artifact = (await compileBlotRuntimeModulesOnRustWasm([hir]))
    .artifacts[0];
  if (artifact === undefined) {
    throw new Error("gpupaper omitted the TypeScript compiler artifact");
  }
  return artifact;
}

async function median(
  sampleCount: number,
  operation: () => Promise<void>,
): Promise<number> {
  const measurements: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const started = performance.now();
    await operation();
    measurements.push(performance.now() - started);
  }
  measurements.sort((left, right) => left - right);
  return medianValue(measurements);
}

function medianValue(measurements: number[]): number {
  measurements.sort((left, right) => left - right);
  const result = measurements[Math.floor(measurements.length / 2)];
  if (result === undefined) throw new Error("benchmark produced no samples");
  return result;
}
