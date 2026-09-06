# Compiler transport and runtime host boundaries

This focused before/after harness isolates host costs without substituting a
second semantic compiler. It does not measure all workloads or prove peak
compiler or generated-code performance.

## Reproduction

Use Node 22.16.0 or newer and the repository's locked dependencies in both
worktrees. Install or build the candidate's verified compiler artifact and
matching prelude snapshot by the normal repository procedure. Supply a separate
baseline worktree containing the original inline `BinaryEncoder` and
`BinaryDecoder` in `src/compiler/wasm.ts`:

```sh
node --expose-gc --import tsx \
  experiments/host-boundary-bench/benchmark.ts /absolute/path/to/baseline \
  > /absolute/path/outside/both/worktrees/host-boundaries.json
```

The reference source is main commit `a9d2719251d98443369b057ebf37f5629f08dbc4`.
Its source tree is `c47ec7a696273cd7ff776ba80fc5fa3fbfc0af4f`; integration
commit `72234bf284c60e4aa0784bb2c6ce1e796218cef8` has the identical tree and is
also suitable. Use the same dependency lockfile and execution environment on
both sides. Do not edit either worktree while a run is collecting samples. Keep
reports outside the hashed harness directory to avoid changing its inputs.

The baseline helper extraction intentionally targets this implementation, not
arbitrary historical compilers. A missing class is an error. Only those two
transport helper classes are transpiled with esbuild; actual compilation calls
each worktree's `CompilerWasm` host against the exact same candidate Rust/Wasm
binary. The candidate artifact's byte count, digest, host ABI, and prelude
digest are validated before loading it.

## Boundaries and controls

The transport cases encode a 1 MiB or 64-byte payload and decode 32,768 u32
fields. Frame construction includes the returned owned frame; decoding includes
reader creation and trailing-byte validation. Unicode and malformed frames are
covered by deterministic unit tests rather than benchmark timings.

The runtime cases call `runArtifact` on the same independently assembled Wasm
fixture. Timed work includes instantiation, canonical result decoding,
post-return, and formatting. Cases are a shallow text result, a depth-12 record
around text, and an array of 1,000 depth-4 records. These are host-adapter
measurements, not warmed execution of generated Blot code. The depth-64 unit
test separately checks linear descriptor traversal without a wall-clock gate.

The compiler cases use a resident compiler instance but a fresh semantic session
for each invocation. Timed work includes source registration and transfer,
module configuration, actual compilation, emitted-artifact extraction, and
session destruction. The inputs are a 128 KiB text literal and a minimal unit
program, with no imports. Compiler module loading and instantiation are outside
timing. Both hosts must emit byte-identical Wasm and manifests for each case.

## Measurements and provenance

Each process uses three warmups and nine samples. Baseline/candidate execution
order alternates within each sample. Optional forced garbage collection happens
outside the clock for each side; its availability is recorded. Small cases run
multiple invocations per sample, with the count reported. Observations feed an
asserted sink and exact byte/value comparisons precede timing.

The JSON preserves raw per-invocation durations, median, median absolute
deviation, range, and ratio. It records Node/V8, CPU, platform, architecture,
invocation flags, both Git heads, host/harness/source and lockfile digests, and
compiler artifact and manifest identities including the build toolchain. Input
provenance is captured before and after the run; disagreement rejects the
report. Repeat independent processes and examine their distributions and control
cases before drawing conclusions. No noisy timing is an absolute CI threshold,
and a large microbenchmark ratio is not a whole-compiler speedup claim.
