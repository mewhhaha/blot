import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { CompilerWasm } from "../src/compiler/wasm.ts";

const exec = promisify(execFile);
const profiles = ["s", "2", "3"] as const;
const compilerStackBytes = 8 * 1024 * 1024;

interface ProfileResult {
  readonly optLevel: typeof profiles[number];
  readonly artifactBytes: number;
  readonly artifactSha256: string;
  readonly shippedCompilerPayloadBytes: number;
  readonly compileMilliseconds: number;
  readonly instantiateMilliseconds: number;
  readonly freshCheckMilliseconds: number;
  readonly semanticEditMilliseconds: number;
  readonly prepareMilliseconds: number;
  readonly compileAfterPrepareMilliseconds: number;
  readonly soakEdits: number;
  readonly soakMilliseconds: number;
  readonly memoryPagesBeforeSoak: number;
  readonly memoryPagesAfterSoak: number;
  readonly emittedWasmBytes: number;
  readonly typeScaling: readonly TypeScalingRow[];
}

interface TypeScalingRow {
  readonly declarations: number;
  readonly checkMilliseconds: number;
  readonly typeNodes: number;
  readonly constraints: number;
  readonly settleVisits: number;
}

function option(name: string): string | null {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((item) =>
    item.startsWith(prefix)
  );
  if (argument === undefined) return null;
  return argument.slice(prefix.length);
}

async function buildProfile(
  optLevel: typeof profiles[number],
  soakEdits: number,
): Promise<ProfileResult> {
  const target = resolve("compiler/target/profile-matrix", optLevel);
  await mkdir(target, { recursive: true });
  const buildEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    CARGO_PROFILE_RELEASE_OPT_LEVEL: optLevel,
    CARGO_PROFILE_RELEASE_LTO: "fat",
    CARGO_PROFILE_RELEASE_CODEGEN_UNITS: "1",
    CARGO_PROFILE_RELEASE_PANIC: "abort",
    CARGO_PROFILE_RELEASE_STRIP: "true",
    CARGO_TARGET_DIR: target,
  };
  let rustFlags = `-C link-arg=-zstack-size=${compilerStackBytes}`;
  const cargoHome = process.env.CARGO_HOME;
  if (cargoHome !== undefined) {
    rustFlags = `--remap-path-prefix=${cargoHome}=/cargo ${rustFlags}`;
  }
  buildEnvironment.RUSTFLAGS = rustFlags;
  await exec("cargo", [
    "build",
    "--manifest-path",
    "compiler/Cargo.toml",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
  ], { env: buildEnvironment });
  const bytes = await readFile(
    resolve(target, "wasm32-unknown-unknown/release/blot_compiler.wasm"),
  );
  const owned = Uint8Array.from(bytes);
  const preludeSnapshot = await readFile(
    resolve("generated/compiler/prelude.snapshot"),
  );
  const compileStart = performance.now();
  const module = await WebAssembly.compile(owned);
  const compileMilliseconds = performance.now() - compileStart;
  const instantiateStart = performance.now();
  await WebAssembly.instantiate(module);
  const instantiateMilliseconds = performance.now() - instantiateStart;

  const compiler = await CompilerWasm.load(owned);
  const handle = compiler.createCompilerSession();
  const path = `/profile-${optLevel}.blot`;
  const preludePath = "snapshot:prelude";
  try {
    const freshStart = performance.now();
    compiler.installCompilerSessionTrustedModuleSnapshot(
      handle,
      preludePath,
      preludeSnapshot,
    );
    const added = compiler.addCompilerSessionModule(
      handle,
      path,
      profileSource(1),
    );
    if (!added.ok) throw new Error(`profile ${optLevel} source was rejected`);
    compiler.configureCompilerSessionModule(handle, path, {
      imports: { "blot:prelude": preludePath },
      includes: {},
    });
    const checked = compiler.checkCompilerSessionModule(handle, path);
    if (!checked.ok) throw new Error(`profile ${optLevel} check failed`);
    const freshCheckMilliseconds = performance.now() - freshStart;

    const editStart = performance.now();
    const edited = compiler.addCompilerSessionModule(
      handle,
      path,
      profileSource(2),
    );
    if (!edited.ok) throw new Error(`profile ${optLevel} edit was rejected`);
    const editedCheck = compiler.checkCompilerSessionModule(handle, path);
    if (!editedCheck.ok) {
      throw new Error(`profile ${optLevel} edited check failed`);
    }
    const semanticEditMilliseconds = performance.now() - editStart;

    const prepareStart = performance.now();
    const prepared = compiler.prepareCompilerSessionRuntimeHir(handle, path);
    if (!prepared.ok) throw new Error(`profile ${optLevel} prepare failed`);
    const prepareMilliseconds = performance.now() - prepareStart;
    const emissionStart = performance.now();
    const artifact = compiler.compileCompilerSessionModule(handle, path);
    if (!artifact.ok) throw new Error(`profile ${optLevel} compile failed`);
    const compileAfterPrepareMilliseconds = performance.now() - emissionStart;

    const memoryPagesBeforeSoak = compiler.memoryPages();
    const soakStart = performance.now();
    for (let edit = 0; edit < soakEdits; edit += 1) {
      const source = `${profileSource(2)}// profile soak ${edit}\n`;
      const result = compiler.addCompilerSessionModule(handle, path, source);
      if (!result.ok) throw new Error(`profile ${optLevel} soak source failed`);
      const check = compiler.checkCompilerSessionModule(handle, path);
      if (!check.ok) throw new Error(`profile ${optLevel} soak check failed`);
    }
    const soakMilliseconds = performance.now() - soakStart;
    const memoryPagesAfterSoak = compiler.memoryPages();
    const typeScaling: TypeScalingRow[] = [];
    for (const declarations of [32, 64, 128, 256]) {
      const scalingHandle = compiler.createCompilerSession();
      const scalingPath = `/profile-${optLevel}-scaling-${declarations}.blot`;
      try {
        const scalingAdded = compiler.addCompilerSessionModule(
          scalingHandle,
          scalingPath,
          scalingSource(declarations),
        );
        if (!scalingAdded.ok) {
          throw new Error(`profile ${optLevel} scaling source was rejected`);
        }
        compiler.configureCompilerSessionModule(scalingHandle, scalingPath, {
          imports: {},
          includes: {},
        });
        const scalingStart = performance.now();
        const scaling = compiler.analyzeCompilerSessionModule(
          scalingHandle,
          scalingPath,
        );
        const checkMilliseconds = performance.now() - scalingStart;
        if (!scaling.ok || scaling.work === null) {
          throw new Error(`profile ${optLevel} scaling check failed`);
        }
        typeScaling.push({
          declarations,
          checkMilliseconds,
          typeNodes: scaling.work.typeNodes,
          constraints: scaling.work.constraints,
          settleVisits: scaling.work.settleVisits,
        });
      } finally {
        compiler.destroyCompilerSession(scalingHandle);
      }
    }
    return {
      optLevel,
      artifactBytes: owned.byteLength,
      artifactSha256: createHash("sha256").update(owned).digest("hex"),
      shippedCompilerPayloadBytes: owned.byteLength +
        preludeSnapshot.byteLength,
      compileMilliseconds,
      instantiateMilliseconds,
      freshCheckMilliseconds,
      semanticEditMilliseconds,
      prepareMilliseconds,
      compileAfterPrepareMilliseconds,
      soakEdits,
      soakMilliseconds,
      memoryPagesBeforeSoak,
      memoryPagesAfterSoak,
      emittedWasmBytes: artifact.wasm.byteLength,
      typeScaling,
    };
  } finally {
    compiler.destroyCompilerSession(handle);
  }
}

function profileSource(result: number): string {
  return `open import "blot:prelude"\n\nreturn ${result}\n`;
}

function scalingSource(declarations: number): string {
  const lines = ["let value0 = 0"];
  for (let index = 1; index <= declarations; index += 1) {
    lines.push(`let value${index} = @int.add value${index - 1} 1`);
  }
  lines.push(`return value${declarations}`);
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  let soakEdits = 10_000;
  const configuredEdits = option("edits");
  if (configuredEdits !== null) soakEdits = Number(configuredEdits);
  if (!Number.isSafeInteger(soakEdits) || soakEdits < 1) {
    throw new Error("--edits must be a positive integer");
  }
  let output = "experiments/compiler-profile-matrix.latest.json";
  const configuredOutput = option("output");
  if (configuredOutput !== null) output = configuredOutput;
  const results: ProfileResult[] = [];
  for (const profile of profiles) {
    results.push(await buildProfile(profile, soakEdits));
  }
  const report = {
    schema: 2,
    controls: {
      lto: "fat",
      codegenUnits: 1,
      panic: "abort",
      strip: true,
      stackBytes: compilerStackBytes,
    },
    node: process.version,
    v8: process.versions.v8,
    results,
  };
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof Error) console.error(error.message);
  else console.error(String(error));
  process.exitCode = 1;
});
