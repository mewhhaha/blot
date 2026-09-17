# Complete compilation investigation

This draft investigates full executable compilation, rather than substituting
semantic analysis or an unchanged artifact-cache hit for compilation. The user
workload remains private. No application source, Wasm, or ABI contents are
published here; the benchmark accepts a locally available entry point.

## Reproduce the measurement boundary

From the repository root, after building the normal compiler distribution:

```sh
node --import tsx experiments/compiler-bench/compile-sample.ts --entry=/absolute/path/main.blot
node --import tsx experiments/compiler-bench/compile-sample.ts --entry=/absolute/path/main.blot --mode=split
node --import tsx experiments/compiler-bench/compile-sample.ts --entry=/absolute/path/main.blot --mode=resident
```

Each invocation is a separate process. `cold` is the default and includes final
Wasm emission. `split` prepares before compiling and labels both intervals.
`resident` also measures an unchanged-source artifact hit; it is not an edited
rebuild. Use a parent-enforced timeout to bound synchronous Wasm stalls. Do not
run builds, other samples, or profilers concurrently with latency measurements.

For an explicitly paired diagnostic compiler and prelude snapshot, supply both
`--wasm=/absolute/path/compiler.wasm` and
`--snapshot=/absolute/path/prelude.snapshot`. Diagnostic build profiles must not
be silently compared with distribution profiles. Source files must stay
unchanged throughout the run. Hashing the observed closure after timing avoids
priming the compiler but is not an atomic filesystem snapshot.

## First diagnosed pathology

Live stacks in both the production compiler and a symbol-retaining build show
residual environment identity construction recursively walking captured closure
values. The encoder already shares record evidence, but recursively expands
persistent function/range type edges and repeatedly encodes attached signature
roots. A binary shared type graph can therefore generate tree-sized evidence.

The first candidate keeps type edges and attached signatures as owned, immutable
chunks within a single identity traversal, using the same closure-reference
stability guard as record evidence. No environment identity is cached across
requests. Exact structural comparisons and the flattened portable evidence
sequence remain authoritative; no hash or pointer replaces semantic evidence.

Native deterministic regressions check graph visit counts,
allocation-independent equality, copy-on-write mutations, variable identity, and
retained signature owners. Actual-workload completion and timing must be
measured independently; a reduced graph test alone does not establish an
end-to-end speedup.

## Status

Investigation and candidate validation are in progress. The target is
millisecond compilation; no completed end-to-end improvement is claimed in this
initial record. Pending and interrupted diagnostic runs are not passing
benchmarks.
