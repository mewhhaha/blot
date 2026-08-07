export interface Workload {
  readonly name: string;
  readonly programPath: string;
  readonly rustConfiguration: string;
  readonly pressure: string;
  readonly exportName: string;
  readonly invocation: "host-input" | "argument";
  readonly inputs: readonly bigint[];
  readonly expected: (input: bigint) => bigint;
}

const MODULUS = 2_147_483_647n;
const dynamicInputs = Array.from(
  { length: 64 },
  (_, index) => 1_000_003n + BigInt(index),
);
const scalingInputs = [16n, 64n, 256n, 1_024n];

export const WORKLOADS: readonly Workload[] = [
  {
    name: "host roundtrip",
    programPath: "experiments/generated-code/programs/host_roundtrip.blot",
    rustConfiguration: "workload_host_roundtrip",
    pressure: "Wasm call and one scalar host import",
    exportName: "blot:default",
    invocation: "host-input",
    inputs: dynamicInputs,
    expected: (input) => input,
  },
  {
    name: "unary identity",
    programPath: "experiments/generated-code/programs/identity.blot",
    rustConfiguration: "workload_identity",
    pressure: "one direct first-order ABI call",
    exportName: "blot:identity",
    invocation: "argument",
    inputs: dynamicInputs,
    expected: (input) => input,
  },
  {
    name: "scalar mix",
    programPath: "experiments/generated-code/programs/scalar_mix.blot",
    rustConfiguration: "workload_scalar_mix",
    pressure: "sixteen dependent integer arithmetic steps",
    exportName: "blot:default",
    invocation: "host-input",
    inputs: dynamicInputs,
    expected: (input) => {
      let state = input;
      for (let increment = 1n; increment <= 16n; increment += 1n) {
        state = (state * 48_271n + increment) % MODULUS;
      }
      return state;
    },
  },
  {
    name: "branch mix",
    programPath: "experiments/generated-code/programs/branch_mix.blot",
    rustConfiguration: "workload_branch_mix",
    pressure: "a seven-leaf dynamic conditional",
    exportName: "blot:default",
    invocation: "host-input",
    inputs: dynamicInputs,
    expected: branchMix,
  },
  {
    name: "function chain",
    programPath: "experiments/generated-code/programs/function_chain.blot",
    rustConfiguration: "workload_function_chain",
    pressure: "sixteen source-level function calls",
    exportName: "blot:default",
    invocation: "host-input",
    inputs: dynamicInputs,
    expected: (input) => {
      let state = input;
      for (let call = 0; call < 16; call += 1) {
        state = (state * 48_271n + 1n) % MODULUS;
      }
      return state;
    },
  },
  {
    name: "fixed array",
    programPath: "experiments/generated-code/programs/fixed_array.blot",
    rustConfiguration: "workload_fixed_array",
    pressure: "owned allocation, eight writes, destructuring, and release",
    exportName: "blot:default",
    invocation: "host-input",
    inputs: dynamicInputs,
    expected: (input) => input * 8n + 36n,
  },
  ...scalingWorkloads(
    "tail recursion",
    "experiments/generated-code/programs/tail_recursion.blot",
    "workload_tail_recursion",
    "blot:sum_to",
    "a dynamic tail-recursive accumulator",
    (count) => count * (count + 1n) / 2n,
  ),
  ...scalingWorkloads(
    "loop mix",
    "experiments/generated-code/programs/loop_mix.blot",
    "workload_loop_mix",
    "blot:mix",
    "a nonlinear data-dependent integer recurrence",
    loopMix,
  ),
  ...scalingWorkloads(
    "array construction",
    "experiments/generated-code/programs/array_construction.blot",
    "workload_array_construction",
    "blot:construct",
    "persistent Store growth without owned-reuse evidence",
    (count) => count,
  ),
  ...scalingWorkloads(
    "range fold",
    "experiments/generated-code/programs/range_fold.blot",
    "workload_range_fold",
    "blot:fold",
    "a dynamic left fold over an integer range",
    (count) => count * (count + 1n) / 2n,
  ),
  ...scalingWorkloads(
    "surface iteration",
    "experiments/generated-code/programs/surface_iteration.blot",
    "workload_surface_iteration",
    "blot:sum_to",
    "a surface for lowered through the iterator protocol",
    (count) => count * (count - 1n) / 2n,
  ),
  ...scalingWorkloads(
    "retained updates",
    "experiments/generated-code/programs/retained_updates.blot",
    "workload_retained_updates",
    "blot:retained_updates",
    "persistent Store writes whose source remains live",
    (count) => count * (count - 1n) / 2n,
  ),
  ...scalingWorkloads(
    "arena list",
    "experiments/generated-code/programs/arena_list.blot",
    "workload_arena_list",
    "blot:arena_list",
    "affine arena construction followed by linked traversal",
    (count) => count * (count + 1n) / 2n,
  ),
  ...scalingWorkloads(
    "recursive list",
    "experiments/generated-code/programs/recursive_list.blot",
    "workload_recursive_list",
    "blot:recursive_list",
    "direct recursive construction and traversal through private indirection",
    (count) => count * (count + 1n) / 2n,
  ),
];

export interface BenchmarkInput {
  input: bigint;
}

export async function instantiateWorkload(
  module: WebAssembly.Module,
  state: BenchmarkInput,
  workload: Workload,
): Promise<(input: bigint) => bigint> {
  const instance = await WebAssembly.instantiate(module, {
    "blot:host/Benchmark": {
      input: () => state.input,
    },
  });
  const exported = instance.exports[workload.exportName];
  if (!(exported instanceof Function)) {
    throw new Error(
      `benchmark artifact omitted the "${workload.exportName}" export`,
    );
  }
  if (workload.invocation === "argument") {
    return exported as (input: bigint) => bigint;
  }
  const hostExport = exported as () => bigint;
  return (_input: bigint) => hostExport();
}

function scalingWorkloads(
  family: string,
  programPath: string,
  rustConfiguration: string,
  exportName: string,
  pressure: string,
  expected: (input: bigint) => bigint,
): readonly Workload[] {
  return scalingInputs.map((input) => ({
    name: `${family} n=${input}`,
    programPath,
    rustConfiguration,
    pressure,
    exportName,
    invocation: "argument",
    inputs: [input],
    expected,
  }));
}

function branchMix(input: bigint): bigint {
  if (input % 2n === 0n) return (input * 3n + 1n) % MODULUS;
  if (input % 3n === 0n) return (input * 5n + 2n) % MODULUS;
  if (input % 5n === 0n) return (input * 7n + 3n) % MODULUS;
  if (input % 7n === 0n) return (input * 11n + 4n) % MODULUS;
  if (input % 11n === 0n) return (input * 13n + 5n) % MODULUS;
  if (input % 13n === 0n) return (input * 17n + 6n) % MODULUS;
  return (input * 19n + 7n) % MODULUS;
}

function loopMix(count: bigint): bigint {
  let remaining = count;
  let state = 1n;
  while (remaining > 0n) {
    state = (state * 48_271n + remaining) % MODULUS;
    remaining -= 1n;
  }
  return state;
}
