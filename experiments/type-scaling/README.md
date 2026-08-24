# Type-mechanics compilation scaling

`pnpm benchmark:type-scaling` generates eight families at sizes 8, 16, 32, 64,
128, and 256, qualifies their emitted Wasm observations, and then measures four
cumulative compiler boundaries. The default is three fresh sessions per point;
`--samples=N` selects any positive odd sample count.

The timed boundary is a warm compiler session whose measured module is not yet
resident. Each path is visited once per phase and sample, and alternating case
order limits systematic warmup bias. `Compiler.create`, source generation,
qualification, and execution are outside the clock. Source loading and graph
synchronization are inside. The cumulative measurements are:

| boundary   | work included                                                     |
| ---------- | ----------------------------------------------------------------- |
| `frontend` | load, Baba frontend, compact CST materialization, portable AST    |
| `check`    | frontend plus elaboration, inference, safety, and ownership       |
| `prepare`  | check plus staging, specialization, and Runtime-HIR validation    |
| `compile`  | prepare plus ABI closure, Core lowering, Wasm emission/validation |

The generated families each grow one intended dimension linearly:

| family        | growing mechanic                                        |
| ------------- | ------------------------------------------------------- |
| `ordinary`    | declarations and arithmetic applications                |
| `structural`  | one exact record and one structural width requirement   |
| `union`       | a closed constructor set and one-column exhaustive case |
| `polymorphic` | fresh uses of one inferred principal type               |
| `refinement`  | fixed-size predicates normalized into integer regions   |
| `wrapper`     | nested generic identity wrappers                        |
| `measure`     | wrapper depth carrying one fixed-array length measure   |
| `evidence`    | independent structural packages carrying index evidence |

All programs return their size as an `i64`. The benchmark fails before timing if
checking, Runtime HIR preparation, emission, Wasm validation, or observation
does not agree with that contract. JSON output includes raw samples, source and
portable-AST bytes, Runtime-HIR nodes, Wasm bytes, and an observational log-log
slope. A slope is a locator for profiling, not a proof of asymptotic complexity.
Passing family names after `--` runs a focused subset, for example
`pnpm benchmark:type-scaling -- wrapper measure --samples=9`.

The `measure` family always calls the deepest wrapper with the same four-element
array. Its source size and wrapper depth grow, but the measured length does not.
The `evidence` family builds `N` independent checked packages; it does not
assume that reconstructing a record through arbitrary wrappers grants a new
transitive proof rule.

Each row also includes resident Rust checker work schema 2: unique type nodes,
recursive intern attempts, constraints, settle/freshen/union visits, boundary
materializations, closure free-name candidates, captures actually bridged, and
peak pending solver worklist items. The executable scaling gate uses the
semantic decisions whose required count is
linear in these sources—constraints, boundary materializations, and capture
selection—and requires the final doubling to stay at or below 2.25. Recursive
graph visits remain visible separately; timing is never replaced by the gate.

## Current results

Measured 2026-08-23 with Node v26.7.0 and compiler SHA-256
`f8a0f6352cf9ab9058a6c1e18c87fd2760d704061f9d0db3e85c623715fdeb2e`. Times are
nine-sample medians in milliseconds. The last-doubling column is the complete
compile-time ratio from `N=128` to `N=256`; it still includes the fixed
per-module floor.

| family      | compile N=8 | compile N=256 | last doubling | frontend N=256 |
| ----------- | ----------: | ------------: | ------------: | -------------: |
| ordinary    |       196.9 |         199.6 |          1.10 |           95.9 |
| structural  |       177.4 |         188.9 |          1.01 |           96.6 |
| union       |       181.2 |         247.2 |          1.23 |          101.5 |
| polymorphic |       182.4 |         203.1 |          1.07 |          100.6 |
| refinement  |       185.0 |         372.9 |          1.35 |          143.1 |
| wrapper     |       180.1 |         603.8 |          2.05 |          101.7 |
| measure     |       185.1 |         731.2 |          2.10 |          100.8 |
| evidence    |       272.7 |         585.0 |          1.46 |          195.2 |

The deterministic last-doubling ratios are 1.990 for `wrapper`, 1.887 for
`measure`, and 1.996 for `evidence`; all pass the 2.25 gate. Ordinary,
structural-row, closed-union, and polymorphic lanes remain close to the fixed
uncached-module floor through 256 elements. Predicate refinements add visible
but controlled semantic work: 256 independently normalized predicates compile in
373 ms.

The profile identified recursive `Type` clone/drop/allocation and repeated
materialization as the expensive representation work. Immutable recursive type
edges and member lists now share their graph, closed-union equality uses
alpha-aware structural comparison with pointer fast paths rather than formatted
keys, settle/residual variable readings are cached conservatively, and evaluated
closures bridge only names that are actually free in their body. A chain of 256
identity wrappers compiles in 604 ms, while the corrected fixed-input length
chain compiles in 731 ms. Their frontends remain about 101 ms, locating the
remaining growth in semantic checking rather than parsing or emission.

The raw settle, freshen, intern, and union visit counters still approach a 4x
doubling in the deepest wrapper families. Sharing makes those visits much
cheaper but does not make them disappear. A tested attempt to replace the live
scheme with its closed residual form made the curve linear but lost directional
information needed by region inference; a dependency-version settle cache was
correct but slower to validate than recomputation. Neither experiment is in the
implementation. A future graph-ID carrier must preserve the live bound
orientation and prove the same principal type before it can remove those walks.

## Typical-code pain points

The accompanying top-level examples intentionally use production-shaped code
rather than feature demonstrations. They expose five concrete friction points:

1. A parameter typed as a structural `Config` may be wider than the named shape,
   so exact record spread cannot preserve its unknown fields. Updating one field
   currently reconstructs every known field. A dedicated shape-preserving record
   update could retain the input row identity without reopening general spread.
2. Empty collection accumulators and higher-order `fold`/`map` pipelines need
   explicit signature headers to retain useful public types. Without them the
   first pass inferred `⊥` for invoice line totals and singleton `0` results for
   the dictionary queries, despite correct evaluation. Bidirectional
   expected-type flow into collection combinators is more valuable than extra
   surface syntax.
3. Counting a dictionary entry requires `get`, an `Option` case, `put`, and `.1`
   to discard the previous value. A prelude-level `Map.alter` or `Map.update`
   would remove this repetition without a primitive.
4. `Text` has comparison, concatenation, length, containment, and integer
   rendering, but no split, trim, scalar iteration, or slicing. The word-count
   example must start from pre-tokenized input, which blocks common parsers and
   command-line/data-cleaning programs.
5. Direct recursive algebraic code is already the pleasant case: the expression
   interpreter is the shortest new example and needed neither an interface nor
   an ownership annotation. That shape should remain the ergonomic baseline.

The priority order suggested by the combined evidence is: preserve live bound
orientation in a future graph-ID scheme carrier, improve expected-type
propagation through collection folds, add ordinary `Map.update` and text-library
coverage, then design a preserving record update separately from general spread.
