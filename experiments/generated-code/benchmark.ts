import { assertEquals } from "@std/assert";
import { RustMiddleCompiler } from "../../src/backend/rust_middle.ts";
import {
  type BenchmarkInput,
  instantiateWorkload,
  type Workload,
  WORKLOADS,
} from "./workloads.ts";

const samples = 11;
const targetSampleMilliseconds = 40;
const maximumInvocations = 1_048_576;
const rustPath = "experiments/generated-code/counterpart.rs";
const sharedBlotPath = "experiments/generated-code/workloads.blot";
interface CompiledWorkload {
  readonly workload: Workload;
  readonly blotBytes: Uint8Array;
  readonly rustBytes: Uint8Array;
  readonly blotModule: WebAssembly.Module;
  readonly rustModule: WebAssembly.Module;
}

const compilerBytes = await Deno.readFile(
  new URL("../../generated/rust-middle/compiler.wasm", import.meta.url),
);
const compiler = await RustMiddleCompiler.create();
const temporaryDirectory = await Deno.makeTempDir({
  prefix: "blot-generated-code-",
});
try {
  const rustVersion = await commandOutput("rustc", ["--version"]);
  const compiledWorkloads: CompiledWorkload[] = [];
  for (const workload of WORKLOADS) {
    const blotArtifact = await compiler.compile(workload.programPath);
    const rustWasmPath =
      `${temporaryDirectory}/${workload.rustConfiguration}.wasm`;
    await compileRust(workload, rustWasmPath);
    const rustBytes = await Deno.readFile(rustWasmPath);
    compiledWorkloads.push({
      workload,
      blotBytes: blotArtifact.wasm,
      rustBytes,
      blotModule: await WebAssembly.compile(
        Uint8Array.from(blotArtifact.wasm),
      ),
      rustModule: await WebAssembly.compile(rustBytes),
    });
  }

  const measurements = [];
  for (const compiled of compiledWorkloads) {
    await validateObservations(compiled);
    measurements.push(await measureWorkload(compiled));
  }

  console.log(JSON.stringify(
    {
      boundary: "generated WebAssembly execution in Deno V8",
      samples,
      aggregation: "median with p10 and p90",
      setup_outside_clock: [
        "Blot and Rust compilation",
        "WebAssembly validation and compilation",
        "module instantiation",
        "warmup",
        "input and observation validation",
      ],
      environment: {
        deno: Deno.version.deno,
        v8: Deno.version.v8,
        rustc: rustVersion,
      },
      artifacts: {
        blot_compiler_sha256: await sha256(compilerBytes),
        shared_blot_source_sha256: await sha256(
          await Deno.readFile(sharedBlotPath),
        ),
        rust_source_sha256: await sha256(await Deno.readFile(rustPath)),
        rust_flags: [
          "--edition=2024",
          "--target=wasm32-unknown-unknown",
          "-O",
          "-Coverflow-checks=yes",
          "-Cpanic=abort",
          "-Cstrip=symbols",
          "--crate-type=cdylib",
        ],
        workloads: await artifactDescriptions(compiledWorkloads),
      },
      measurements,
    },
    null,
    2,
  ));
} finally {
  compiler.destroy();
  await Deno.remove(temporaryDirectory, { recursive: true });
}

async function measureWorkload(compiled: CompiledWorkload) {
  const inputs = compiled.workload.inputs;
  const blotInvocations = await calibrate(
    compiled.blotModule,
    compiled.workload,
  );
  const rustInvocations = await calibrate(
    compiled.rustModule,
    compiled.workload,
  );
  const blotSamples: number[] = [];
  const rustSamples: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    if (sample % 2 === 0) {
      blotSamples.push(
        await measure(
          compiled.blotModule,
          compiled.workload,
          blotInvocations,
        ),
      );
      rustSamples.push(
        await measure(
          compiled.rustModule,
          compiled.workload,
          rustInvocations,
        ),
      );
    } else {
      rustSamples.push(
        await measure(
          compiled.rustModule,
          compiled.workload,
          rustInvocations,
        ),
      );
      blotSamples.push(
        await measure(
          compiled.blotModule,
          compiled.workload,
          blotInvocations,
        ),
      );
    }
  }
  const blot = summarize(blotSamples, blotInvocations);
  const rust = summarize(rustSamples, rustInvocations);
  return {
    name: compiled.workload.name,
    pressure: compiled.workload.pressure,
    input_cycle: {
      first: inputs[0].toString(),
      last: inputs[inputs.length - 1].toString(),
      length: inputs.length,
    },
    blot,
    rust,
    blot_over_rust: blot.median_nanoseconds_per_call /
      rust.median_nanoseconds_per_call,
  };
}

async function calibrate(
  module: WebAssembly.Module,
  workload: Workload,
): Promise<number> {
  let invocations = 1;
  while (true) {
    const elapsed = await measure(module, workload, invocations);
    if (
      elapsed >= targetSampleMilliseconds ||
      invocations === maximumInvocations
    ) {
      return invocations;
    }
    invocations = Math.min(invocations * 2, maximumInvocations);
  }
}

async function measure(
  module: WebAssembly.Module,
  workload: Workload,
  invocations: number,
): Promise<number> {
  const inputs = workload.inputs;
  const state: BenchmarkInput = { input: inputs[0] };
  const run = await instantiateWorkload(module, state, workload);
  for (let warmup = 0; warmup < 64; warmup += 1) {
    state.input = inputs[warmup % inputs.length];
    run(state.input);
  }
  let observed = 0n;
  const started = performance.now();
  for (let invocation = 0; invocation < invocations; invocation += 1) {
    state.input = inputs[invocation % inputs.length];
    observed = run(state.input);
  }
  const elapsed = performance.now() - started;
  assertEquals(
    observed,
    workload.expected(inputs[(invocations - 1) % inputs.length]),
  );
  return elapsed;
}

function summarize(milliseconds: number[], invocations: number) {
  const nanoseconds = milliseconds
    .map((elapsed) => elapsed * 1_000_000 / invocations)
    .sort((left, right) => left - right);
  return {
    invocations_per_sample: invocations,
    median_nanoseconds_per_call: percentile(nanoseconds, 0.5),
    p10_nanoseconds_per_call: percentile(nanoseconds, 0.1),
    p90_nanoseconds_per_call: percentile(nanoseconds, 0.9),
  };
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.floor((sorted.length - 1) * fraction)];
}

async function validateObservations(
  compiled: CompiledWorkload,
): Promise<void> {
  const state = { input: 0n };
  const blot = await instantiateWorkload(
    compiled.blotModule,
    state,
    compiled.workload,
  );
  const rust = await instantiateWorkload(
    compiled.rustModule,
    state,
    compiled.workload,
  );
  for (const input of compiled.workload.inputs) {
    state.input = input;
    const expected = compiled.workload.expected(input);
    assertEquals(
      blot(input),
      expected,
      `${compiled.workload.name}: Blot at ${input}`,
    );
    assertEquals(
      rust(input),
      expected,
      `${compiled.workload.name}: Rust at ${input}`,
    );
  }
}

async function artifactDescriptions(
  compiledWorkloads: readonly CompiledWorkload[],
) {
  const unique = compiledWorkloads.filter((compiled, index) =>
    compiledWorkloads.findIndex((candidate) =>
      candidate.workload.programPath === compiled.workload.programPath &&
      candidate.workload.rustConfiguration ===
        compiled.workload.rustConfiguration
    ) === index
  );
  const hostBaseline = compiledWorkloads.find((compiled) =>
    compiled.workload.name === "host roundtrip"
  );
  const argumentBaseline = compiledWorkloads.find((compiled) =>
    compiled.workload.name === "unary identity"
  );
  if (hostBaseline === undefined || argumentBaseline === undefined) {
    throw new Error("artifact size baselines were not compiled");
  }
  const descriptions = [];
  for (const compiled of unique) {
    let baseline = argumentBaseline;
    if (compiled.workload.invocation === "host-input") {
      baseline = hostBaseline;
    }
    descriptions.push({
      name: compiled.workload.name,
      blot_entry: compiled.workload.programPath,
      blot_entry_sha256: await sha256(
        await Deno.readFile(compiled.workload.programPath),
      ),
      rust_configuration: compiled.workload.rustConfiguration,
      boundary: compiled.workload.invocation,
      blot_wasm_sha256: await sha256(compiled.blotBytes),
      rust_wasm_sha256: await sha256(compiled.rustBytes),
      blot_wasm_bytes: compiled.blotBytes.byteLength,
      rust_wasm_bytes: compiled.rustBytes.byteLength,
      blot_marginal_bytes: compiled.blotBytes.byteLength -
        baseline.blotBytes.byteLength,
      rust_marginal_bytes: compiled.rustBytes.byteLength -
        baseline.rustBytes.byteLength,
    });
  }
  return descriptions;
}

async function compileRust(
  workload: Workload,
  outputPath: string,
): Promise<void> {
  const rustArguments = [
    "--edition=2024",
    "--target=wasm32-unknown-unknown",
    "-O",
    "-Coverflow-checks=yes",
    "-Cpanic=abort",
    "-Cstrip=symbols",
    "--crate-type=cdylib",
    "--cfg",
    workload.rustConfiguration,
    rustPath,
    "-o",
    outputPath,
  ];
  const command = new Deno.Command("rustc", {
    args: rustArguments,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (result.success) return;
  throw new Error(
    `rustc failed with exit ${result.code}: ${
      new TextDecoder().decode(result.stderr)
    }`,
  );
}

async function commandOutput(command: string, args: string[]): Promise<string> {
  const result = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(`${command} failed with exit ${result.code}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
