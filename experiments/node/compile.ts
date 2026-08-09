import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { installDenoShim } from "./deno_shim.ts";

installDenoShim();

const [
  { load },
  { checkFile },
  { stageModule },
  { exportResidualRuntimeHir },
  { validateBlotRuntimeModule },
  { compileBlotRuntimeModulesOnRustWasm },
] = await Promise.all([
  import("../../src/load.ts"),
  import("../../src/check/mod.ts"),
  import("../../src/stage.ts"),
  import("../../src/conformance/gpufuck/gpupaper_residual.ts"),
  import("../../src/runtime/hir.ts"),
  import("../../src/conformance/gpufuck/runtime/target.ts"),
]);

interface Arguments {
  readonly input: string;
  readonly output?: string;
}

function usage(): string {
  return [
    "Usage: npm run node:compile -- [source.blot] [--out artifact.wasm]",
    "",
    "Defaults to examples/minimal.blot and validates the emitted WebAssembly",
    "without writing an artifact unless --out is supplied.",
  ].join("\n");
}

function arguments_(): Arguments {
  let input = "examples/minimal.blot";
  let output: string | undefined;
  let sawInput = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--out") {
      const candidate = args[index + 1];
      if (candidate === undefined) {
        throw new TypeError("--out requires a path");
      }
      output = candidate;
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new TypeError(`unknown option ${JSON.stringify(argument)}`);
    }
    if (sawInput) {
      throw new TypeError(`unexpected argument ${JSON.stringify(argument)}`);
    }
    input = argument;
    sawInput = true;
  }
  return { input: resolve(input), output };
}

async function prepareRuntimeHir(path: string) {
  const loaded = await load(path);
  const checked = await checkFile(path);
  if (loaded.closure.tag !== "closure") {
    throw new Error("a module must load as a closure");
  }
  let imports = new Map();
  if (loaded.closure.imports !== undefined) {
    imports = loaded.closure.imports;
  }
  const staged = stageModule(
    loaded.module,
    checked.values,
    imports,
    checked.shapes,
    checked.recordAdaptations,
  );
  return {
    loaded,
    hir: exportResidualRuntimeHir(
      loaded.path,
      checked,
      staged.exports,
      "blot:default",
    ),
  };
}

const options = arguments_();
const prepared = await prepareRuntimeHir(options.input);
const module = validateBlotRuntimeModule(prepared.hir);
const batch = await compileBlotRuntimeModulesOnRustWasm(
  [module],
  { target: "wasm-simd128" },
);
const artifact = batch.artifacts[0];
if (artifact === undefined) {
  throw new Error("gpupaper returned no artifact");
}
if (!WebAssembly.validate(artifact.wasm)) {
  throw new Error("gpupaper returned invalid WebAssembly");
}

if (options.output !== undefined) {
  const output = resolve(options.output);
  await writeFile(output, artifact.wasm);
  await writeFile(`${output}.abi.json`, artifact.manifestBytes);
}

const capabilities = [
  ...new Set(artifact.manifest.imports.map((imported) => imported.capability)),
].sort();

console.log(JSON.stringify({
  source: prepared.loaded.path,
  pipeline: [
    "baba-cpu",
    "blot-typescript",
    "gpupaper-rust-wasm",
  ],
  wasmBytes: artifact.wasm.byteLength,
  manifestBytes: artifact.manifestBytes.byteLength,
  capabilities,
  output: options.output,
}, null, 2));
