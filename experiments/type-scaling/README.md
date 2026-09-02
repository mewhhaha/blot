# Type-mechanics compilation scaling

`pnpm benchmark:type-scaling` generates thirteen families at sizes 8, 16, 32,
64, 128, and 256, qualifies their emitted Wasm observations, and then measures
four cumulative compiler boundaries. The default is three fresh sessions per
point; `--samples=N` selects any positive odd sample count and
`--sizes=16,32,64` selects positive source sizes. A single selected size reports
`null` timing slopes.

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

| family           | growing mechanic                                        |
| ---------------- | ------------------------------------------------------- |
| `ordinary`       | declarations and arithmetic applications                |
| `structural`     | one exact record and one structural width requirement   |
| `union`          | a closed constructor set and one-column exhaustive case |
| `polymorphic`    | fresh uses of one inferred principal type               |
| `refinement`     | fixed-size predicates normalized into integer regions   |
| `wrapper`        | nested generic identity wrappers                        |
| `measure`        | wrapper depth carrying one fixed-array length measure   |
| `evidence`       | independent structural packages carrying index evidence |
| `dense_case`     | dense demand-driven multi-subject case cells            |
| `operator_chain` | terms in one left-associative operator chain            |
| `literal_union`  | closed singleton members in one type union              |
| `projection`     | fields projected from one structural record             |
| `ownership`      | live owned bindings observed across case arms           |

All programs return their size as an `i64`. The benchmark fails before timing if
checking, Runtime HIR preparation, emission, Wasm validation, or observation
does not agree with that contract. JSON output includes raw samples, source and
portable-AST bytes, Runtime-HIR nodes, Wasm bytes, and an observational log-log
slope. A slope is a locator for profiling, not a proof of asymptotic complexity.
Passing family names after `--` runs a focused subset, for example
`pnpm benchmark:type-scaling -- wrapper measure --samples=9`.

The `measure` family always calls the deepest wrapper with the same borrowed
four-element array. Its source size and wrapper depth grow, but the measured
length does not and no wrapper claims ownership of the array. The `evidence`
family builds `N` independent checked packages; it does not assume that
reconstructing a record through arbitrary wrappers grants a new transitive proof
rule.

Each row also includes resident Rust checker work schema 3: unique type nodes,
recursive intern attempts, constraints, settle/freshen/union visits, boundary
materializations, closure free-name candidates, captures actually bridged,
opened interface fields actually demanded, and peak pending solver worklist
items. The executable scaling gate uses constraints, boundary materializations,
and capture selection as semantic decisions. It also gates the wrapper and
measure families on the sum of unique type nodes, intern attempts, and freshen
visits, and reports settle plus union visits as recursive solver work, so cheap
timings cannot hide a superlinear semantic graph. The wrapper, measure,
evidence, operator-chain, literal-union, projection, and ownership families
require the final doubling to stay at or below 2.25. Dense multi-subject cases
require semantic decisions at or below 2.25 and recursive solver work at or
below 3.0. Guard-free nullary-constructor matrices lower to an ordered decision
tree; the separate solver ceiling catches a return to copied row-fallback type
graphs even when the decision counter remains linear. Timing is never replaced
by the gate. When custom sizes grow by more than 2×, the gate reports the
equivalent doubling derived from that actual size ratio.

## Current results

Measured 2026-09-01 with Node v24.12.0 and compiler SHA-256
`4e14bedd8546eccb2f0442b7973b4deca1bbb11e3ae0912768a79b73fb4b7552`. Times are
three-sample medians in milliseconds. The focused run extends the two deepest
type-graph families through 512 declarations:

| family  | compile N=64 | compile N=256 | compile N=512 | semantic doubling | graph doubling |
| ------- | -----------: | ------------: | ------------: | ----------------: | -------------: |
| wrapper |         17.6 |          68.8 |         141.3 |             1.997 |          1.997 |
| measure |         25.0 |          85.6 |         206.5 |             1.928 |          1.932 |

The doubling columns compare deterministic work from `N=256` to `N=512`, not
wall-clock time. The complete thirteen-family run at the default sizes also
passes every gate. Its `N=128` to `N=256` semantic/graph ratios are 1.993/1.994
for `wrapper` and 1.865/1.872 for `measure`; the remaining gated semantic ratios
range from 1.956 to 2.007.

A focused dense-matrix run after the ordered decision-tree change used compiler
SHA-256 `50a275223e50929d5ab3809319d4a1c66878a646258538620238c6c987dece23`:

| family       | compile N=64 | compile N=256 | compile N=512 | compile N=1024 | semantic doubling | solver doubling |
| ------------ | -----------: | ------------: | ------------: | -------------: | ----------------: | --------------: |
| `dense_case` |         20.3 |          49.5 |          78.0 |          139.6 |             1.520 |           1.302 |

The doubling columns compare deterministic work from `N=512` to `N=1024`. The
source grows from 64 to 1,024 case cells while compile time grows by 6.9×; both
semantic gates pass. With the same artifact, the structural-row family grows
from 128 to 1,024 fields while compile time grows from 27.9 ms to 180.1 ms; its
observed compile slope is 0.89.

A focused one-sample literal-union run with compiler SHA-256
`7421a25bd61ae730fee22052540f044fc1fb74545e52e9da31f1f0f9b2fe881d` compiled 256,
512, and 1,024 distinct singleton members in 42.4 ms, 83.4 ms, and 272.6 ms. The
observed compile slope was 1.34 and the deterministic semantic doubling was
2.000. Before persistent indexed union construction, the audited 1,024-member
point took 2,097.6 ms.

The profile identified retained private constraint chains and repeated recursive
scheme materialization as the expensive representation work. A nonrecursive
generalized binding now publishes a compact lexical scheme: variables exposed by
its public body remain distinct, while private variable-only paths project to
their directional endpoints. This carrier is separate from the checked closure
graph, so ownership and recursive representation facts retain the original live
constraints. Instantiation freshens the compact flat graph by constraint ID and
expands only its result. At 512 declarations, `wrapper` contains 11,793 unique
type nodes and 2,563 freshen visits; `measure` contains 6,910 nodes and 4,109
freshen visits. Both grow linearly under the graph gate.

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

The remaining priority order suggested by the typical-code examples is: improve
expected-type propagation through collection folds, add ordinary `Map.update`
and text-library coverage, then design a preserving record update separately
from general spread.
