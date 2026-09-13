# Canonical-layout and text-search pathologies

This experiment separates two costs that ordinary short examples hide.

**Compilation:** a chain of single-field records with two dynamic leaves forces
an indirect canonical result. Previously each record's layout recomputed every
child three times and cloned recursive field types. `nestedRecordSource` scales
the depth without changing the 16-byte result. The fix retains a child's layout
and borrows its type. The Rust test counts exactly one visit per structural type
occurrence for an individual layout query; sorting wide records and other
compiler passes have separate costs.

**Runtime:** both text operands are canonical runtime inputs, not compile-time
constants. An all-`a` haystack and an `a…ab` query force the former substring
helper to retry long prefixes. The shared Two-Way helper also handles periodic
queries, early mismatches, overlaps, empty queries, arbitrary bytes internally,
and UTF-8 scalar offsets at the public boundary. It performs no allocation or
input writes. Scalar-indexed searches retain their conversion costs; composite
splitting and replacement now carry byte positions between matches.

Run with the compiler artifact rebuilt from the same source revision:

```sh
pnpm compiler:build
cargo test --manifest-path compiler/Cargo.toml backend::text_search::tests
cargo test --manifest-path compiler/Cargo.toml record_memory_layout
cargo test --manifest-path compiler/Cargo.toml record_layout_borrows
node --import tsx --test src/node/performance_pathologies.test.ts
node --import tsx experiments/performance-pathologies/benchmark.ts
```

`benchmark.ts` emits JSON containing raw samples, compiler artifact provenance,
and host versions. Input preparation, Wasm instantiation, output validation, and
runtime warmup are outside runtime measurements. Compiler measurements use
unique files and a warmed compiler session, so they include source loading,
checking, preparation, and emission rather than a cache-hit benchmark. Results
are qualified by executing both dynamic record leaves and exact search results.
Use identical arguments and runtime versions for before/after runs. The default
depths stay bounded on the original compiler; `--depths=16,32` is useful after
the fix. Times are not portable thresholds and do not establish whole-compiler
or whole-application asymptotic complexity.

The two `examples/pathological_*.blot` catalog programs retain evaluator
goldens. The Node tests generate larger workloads; the Rust instruction tests
enforce a linear byte-load budget, reject accesses outside the supplied slices,
and fail on unsupported instructions. These deterministic checks, not benchmark
timing, protect against restoring the pathological algorithms.

The normative boundary is
[the cost model](../../spec/COST_MODEL.md#8-adversarial-canonical-layouts-and-substring-search).

## Composite traversal

`text_composition.ts` repeats the September triage's dense-delimiter workload.
It compiles once, warms each export three times per size, and records seven
calls including canonical argument/result adaptation. Input construction,
compilation, warmup, and result assertions are outside each measured interval.
It emits raw samples, compiler provenance and host versions:

```sh
node --import tsx experiments/performance-pathologies/text_composition.ts
```

The implementation carries monotone UTF-8 byte positions through search and
slicing, and joins replacement chunks once. The emitted-instruction tests bound
total byte work across successive searches and the byte-boundary validator's
instruction shape; Unicode and empty-query behavior have evaluator/Wasm tests.
The measurements in
[the implementation ledger](../../docs/triage-implementation.md) are local
observations, not portable timing gates.

## Source float presentation

`float_format.ts` measures the pure `blot:float` formatter at ordinary and
extreme binary32/binary64 values:

```sh
node --import tsx experiments/performance-pathologies/float_format.ts
```

The compile clock includes source checking and compilation in a newly created
compiler session, but excludes compiler creation and guest instantiation. After
three warmup calls per value, seven batches of 100 calls include canonical
argument/result adaptation and the exact output assertion. JSON retains every
per-call batch mean, its median, emitted Wasm size, compiler provenance and host
versions. These observations are not a portable latency gate or a comparison
with a native host formatter. The exact interval algorithm uses source arrays;
it trades some code size and runtime allocation for a pure implementation with
no formatting primitive or host service.

## Bounded command-line inputs

Options use `--depths=4,8`, `--sizes=4096,8192`, and `--samples=3`. A single
leading `--` separator is accepted. Values must be positive decimal integers;
empty entries, whitespace, exponent notation, duplicate flags, and unknown
arguments are rejected before creating a compiler or temporary directory.

Each list accepts at most 16 values. Depths are bounded to 64, text sizes to
131072 bytes, and samples to 101. These are operational bounds for this
benchmark, not new language or compiler limits. Defaults are unchanged.
