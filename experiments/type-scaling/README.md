# Type-mechanics compilation scaling

`pnpm benchmark:type-scaling` generates seven families at sizes 8, 16, 32, 64,
128, and 256, qualifies their emitted Wasm observations, and then measures four
cumulative compiler boundaries with three fresh sessions per point.

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

| family         | growing mechanic                                        |
| -------------- | ------------------------------------------------------- |
| `ordinary`     | declarations and arithmetic applications                |
| `structural`   | one exact record and one structural width requirement   |
| `union`        | a closed constructor set and one-column exhaustive case |
| `polymorphic`  | fresh uses of one inferred principal type               |
| `refinement`   | fixed-size predicates normalized into integer regions   |
| `wrapper`      | nested identity wrappers and relationship summaries     |
| `relationship` | wrapper depth for a memoizable `Array.length` summary   |

All programs return their size as an `i64`. The benchmark fails before timing if
checking, Runtime HIR preparation, emission, Wasm validation, or observation
does not agree with that contract. JSON output includes raw samples, source and
portable-AST bytes, Runtime-HIR nodes, Wasm bytes, and an observational log-log
slope. A slope is a locator for profiling, not a proof of asymptotic complexity.
Passing family names after `--` runs a focused subset, for example
`pnpm benchmark:type-scaling -- wrapper relationship`.

## Current results

Measured 2026-08-23 with Node v26.7.0 and compiler SHA-256
`e1cb23ebd424edad08cf9fb96b5c9e5fb806d50c885c28c3f676c04885d2434d`. Times are
three-sample medians in milliseconds. The last-doubling column is the complete
compile-time ratio from `N=128` to `N=256`; it still includes the fixed
per-module floor.

| family       | compile N=8 | compile N=256 | last doubling | frontend N=256 |
| ------------ | ----------: | ------------: | ------------: | -------------: |
| ordinary     |       188.4 |         177.4 |          1.02 |           91.6 |
| structural   |       162.9 |         168.9 |          1.01 |           90.2 |
| union        |       161.7 |         218.1 |          1.19 |           93.8 |
| polymorphic  |       170.1 |         190.3 |          1.07 |           94.4 |
| refinement   |       171.9 |         442.0 |          1.49 |          128.7 |
| wrapper      |       169.7 |         636.9 |          2.11 |           92.3 |
| relationship |       165.3 |       2,206.8 |          3.95 |           96.6 |

The ordinary, structural-row, closed-union, and polymorphic lanes remain close
to the fixed 160--190 ms uncached-module floor through 256 elements. Predicate
refinements add visible but controlled semantic work: 256 independently
normalized predicates compile in 442 ms, while their frontend alone is 129 ms.

Deep higher-order relationships are the outlier. A chain of 256 identity
wrappers takes 637 ms; carrying `Array.length` evidence through the same depth
takes 2.21 s. Its frontend remains 97 ms, and `check`, `prepare`, and `compile`
all converge on the same time. The hotspot is therefore checking and relational
summary composition, not parsing, Runtime HIR, ABI closure, or emission. Every
lane erases to three Runtime-HIR nodes and 1,066--1,076 Wasm bytes.

The current `Summaries` cache is keyed by closure body and environment identity,
but the end-to-end wrapper curves are still superlinear. The next profile should
count relationship-summary derivations, cache hits, substituted transform size,
and environment-key identities. A likely repair is to summarize the reachable
closure graph bottom-up by stable closure identity and make
relationship-relevant captures explicit in the key, rather than recursively
composing an overlapping prefix for each wrapper. That is a hypothesis to
profile, not yet a claimed cause.

## Typical-code pain points

The accompanying top-level examples intentionally use production-shaped code
rather than feature demonstrations. They expose five concrete friction points:

1. A parameter typed as a structural `Config` may be wider than the named shape,
   so exact record spread cannot preserve its unknown fields. Updating one field
   currently reconstructs every known field. A dedicated shape-preserving record
   update could retain the input row identity without reopening general spread.
2. Empty collection accumulators and higher-order `fold`/`map` pipelines need
   explicit `sig` anchors to retain useful public types. Without them the first
   pass inferred `⊥` for invoice line totals and singleton `0` results for the
   dictionary queries, despite correct evaluation. Bidirectional expected-type
   flow into collection combinators is more valuable than extra surface syntax.
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

The priority order suggested by the evidence is: fix relationship-summary
scaling, improve expected-type propagation through collection folds, add
ordinary `Map.update` and text-library coverage, then design a preserving record
update separately from general spread.
