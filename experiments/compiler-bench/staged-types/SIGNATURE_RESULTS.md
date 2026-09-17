# Lazy signature evidence: mixed timing result

The signature-selection and cached-summary increment passes correctness checks
and removes specific unnecessary operations. It does **not** demonstrate a
reliable compilation-time improvement in this batch. Keep this PR draft; do not
present this increment as a measured speed fix.

## Source and measurement boundary

Measured on September 17, 2026. The baseline is the previously published
PR implementation `b1b3ccb5c409bff091bcb8cebf990f87cb97487d`, which already includes
demand-driven expression evidence. The candidate is
`b56a70e2a8c21da0e2ba6636cf340833d7065c81`. This is not a comparison against main
or against the original persistent-type experiment. Earlier absolute timings
were collected on another host and must not be compared with this batch.

Both artifacts were rebuilt locally with pinned Rust 1.97.1, the same bare Cargo
release profile, and unchanged compiler dependencies. The profile uses size
optimization, fat LTO, one codegen unit, panic abort, and stripping. These bare
Cargo artifacts are not the normal distribution build, whose script adds linker
and path-remapping flags. Compiler sources in the published increment were
verified against the tested file hashes before a non-forced branch update.

Host: Node v22.16.0, Linux x64, AMD EPYC 9V74 80-Core Processor. This is a shared
container, not a dedicated performance machine. No other local compiler builds
or test suites ran during the timing batches.

There are forty fresh-process observations: five per artifact, fixture, and
telemetry setting. Artifact order alternates by iteration. Telemetry-off was run
first, then telemetry-on. No observations were discarded. Each sample creates a
new compiler session and uses the same tracked prelude snapshot. The unchanged
comparison driver rejects differences in inputs, principal types, effects,
interface keys, and target preflight.

The timer includes semantic analysis, fact materialization, and target preflight.
It excludes compiler Wasm instantiation, snapshot installation, source setup,
final executable emission, and executable runtime. These are not end-to-end CLI
compilation measurements. Raw samples, including phase telemetry when enabled,
are retained in `signature-off.jsonl` and `signature-on.jsonl`.

## Results

Times are milliseconds; positive changes mean slower. Five samples per cell are
not enough to establish small differences on this shared host.

```text
telemetry fixture   baseline median  candidate median  change
Off       Prefix           901.179           962.362   +6.79%
Off       Full            9703.202          9478.153   -2.32%
On        Prefix           918.049           891.773   -2.86%
On        Full            9354.181          9513.592   +1.70%
```

The direction reverses between telemetry settings for both fixtures. Neither a
universal speedup nor a statistically established regression is claimed. The
full telemetry-enabled evaluator median is 6520.326 ms for baseline versus
6629.762 ms for candidate. The prefix evaluator median is 125.244 ms versus
116.576 ms.

All forty samples retain `{ .run = Int -> Int }`, empty effects, the same
interface key, and supported target preflight. Every evaluator counter matches
between versions: full still performs 2,237,600 trampoline transitions and
332,118 closure applications; prefix performs 38,202 transitions and 5,282
closure applications. This increment does not reduce source-level staged work.

Not every solver counter is identical. Full semantic preparation reports
443,664 versus 443,730 settle visits and 54,060 versus 54,102 union visits.
Prefix reports 228,794 versus 228,940 settle visits and 26,486 versus 26,544
union visits. These differences are retained rather than omitted from the data.

Allocated Wasm linear memory at analysis completion is 40,370,176 bytes in both
prefix versions. Full increases from 117,374,976 to 117,440,512 bytes, one Wasm
page. This is not process RSS or peak live-heap usage.

## What the code changes

Closure application now selects attached signature evidence before requesting a
recursive lexical fallback, and requests inferred evidence only when both are
absent. This retains the existing precedence and does not cache absence. The
inferred resolver can reify fresh representation holes; unused fallback evidence
is no longer constructed merely to be discarded.

A selected signature without variable, effect-identity, or normalization
dependencies retains its immutable shared root. Dependent signatures still
substitute against the current call environment, including after environment
changes. This is not broader memoization, a new subtype relation, or permission
to share fresh effects or closure results.

Function and range roots combine cached immutable edge summaries without
allocating another traversal worklist. A missing summary still uses bounded-stack
traversal. Copy-on-write mutation invalidates cached summaries before exposing
mutable data. Effect-row tails and union-normalization obligations remain part
of the summary.

## Validation

The exact compiler increment passes 678 native tests, with zero failures and one
existing diagnostic benchmark intentionally ignored. Nine new regressions cover
signature precedence, lazy fallback demand, absence not being cached,
environment changes, effect identity substitution, union normalization,
allocation-free warmed root queries, effect-tail flags, and copy-on-write
invalidation. The existing deep-graph bounded-stack regression also passes.

Rust formatting, Wasm-target Clippy with warnings denied, and release-Wasm
compilation pass. All 37 locally registered abstraction suites complete:
177 tests pass, with no failures, cancellations, or skips. Those suites run the
new compiler artifact, whose manifest matches its bytes and compiler-input
identity; no older compiler or TypeScript semantic fallback is substituted.

The nine new tests establish specific operation-count and semantic properties,
not an end-to-end speed guarantee. The remaining dominant repeated execution of
abstraction-building code is still an architectural performance problem.

Hosted checks are separate from this local evidence. The preceding published
head passed hosted type-system and abstraction validation, including the normal
build script and prelude-snapshot freshness. Hosted checks for this increment
must be read on its actual commit; pending checks are not claimed as successful.

## Artifact and input identities

```text
baseline Wasm SHA-256
  a457e2b17c3bd71f512251766ce620c3f35cc61482b7f24976d39d79c140693b
candidate Wasm SHA-256
  5ab287d36283ec5b1e90ba99fdc83f7ff8f2b531880ba0443bb49f516cb4c6d5
candidate compiler-input SHA-256
  6d16b4b9f71511ad7eef03090908c4870a2f6ca229bedecfa9eb249f8fec6396
prelude source SHA-256
  257f18f8fbcd0b7d7c991d0f6cf6af4f51e0c1f5b7704fb11e99845848e1064f
prelude snapshot SHA-256
  87718708480be1ebe78c1c6cff3944c8e78cafce48157495dad3c780df7bd57f
framework SHA-256
  18b5829343fa977c0cea93834352d9b3e418f321a080cc069c68e57fbfe04e15
prefix SHA-256
  009d4e05d86b3b437f036ee7573656506bc72141186c9f58214079908faa168e
full SHA-256
  8ec9d28a1c8c6b9bd4a345881e91a0c2c6b55f147f5e535d217459289d324054
```

Baseline artifact size: 7,276,617 bytes. Candidate: 7,276,762 bytes. Both use the
unchanged comparison driver from the published demanded-evaluation increment.

## Reproduction

Build both source revisions with the pinned toolchain and identical profile,
retain their compiler Wasm files separately, and run from the candidate checkout:

```sh
for telemetry in off on; do
  node experiments/compiler-bench/staged-types/compare.mjs \
    --baseline=/path/to/baseline.wasm \
    --candidate=/path/to/candidate.wasm \
    --samples=5 --telemetry="$telemetry" \
    > "signature-$telemetry.jsonl"
done
```
