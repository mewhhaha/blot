# Triage implementation

Implements the accepted work from
[the September 12 triage](language-triage-2026-09-12.md). Existing working-tree
refinement and cache changes are retained.

- [x] Typed evaluator/Wasm observations, truthful ABI metadata, and executable
      backlog inventory.
- [x] Imported handler clause provenance and ownership, including capsule reuse
      and rejection cases.
- [x] Linear composite text traversal, measured and checked in both executions.
- [x] Typed function parameters/results, record shorthand, multiline record
      fields, formatter and highlighting.
- [x] Effectful pipeline adapters, Array.find, Iter.map, and source integer
      parsing.
- [x] Revisit the concrete formatting, module-input, and codec additions against
      the new surface.
- [x] Development-latency profile and improvement with unchanged correctness and
      latency gates.
- [x] Rebuild compiler/package, regenerate derived contracts, run focused/full
      checks and game acceptance.

Deferred designs and deliberate restrictions remain as triaged.

## Syntax and presentation

Functions accept `fn (a :: Int, b :: Int) -> Int => do:` headers, including
qualifiers, destructuring, recursion, deferred arrows, and written effect rows.
Separate signatures remain available and constrain the same definition. `do:`
remains explicit for statement bodies. Record `.name` fields elaborate to
ordinary variable lookup; vertical record fields may end at the next field's
line boundary. Inline fields retain explicit separators.

The formatter and highlighting follow these forms. Baba accepts the version-3
general profile, all 71 rules are islands, and there are no parser resolutions.
[The profile](gpu-profile.md) records the changed counters. The visual
comparison passed 28 example/width/theme checks and its color toggle, including
360px dark and light layouts. Syntax tests cover nested suites, continuation
dots, comments, annotation errors, and formatting the executable catalog twice.

## Compiler correctness

- Imported handler clauses retain their defining module and checked continuation
  and operation ownership contracts. Tests execute local, imported, and aliased
  builders, provider revisions, cached artifacts, linear resumption and
  cancellation, and rejected duplication or abandonment.
- Staged handlers retain captures in their enclosing frame. Missing checked SSA
  facts remain compiler invariant failures with their actual source location.
- Closed variants with different scalar payload lanes use bit-preserving joined
  lanes. Equivalent checked sums reuse a case order. Tests cover nested
  variants, arrays, signed zero, nonfinite floats, text, and suspended host
  round trips. The public guest ABI remains 4; mixed SIMD/scalar lanes remain a
  target refusal.
- `$` and `|>` carry their callback's effect row. Inference preserves an
  explicit empty-row contribution, so pure callbacks remain usable with borrows
  while suspending or unresolved callbacks are rejected. Direct and pipeline
  forms have the same restriction.
- Conformance compares typed values rather than display strings, including exact
  integers, F32 values, signed zero, Unicode, records, and variants. Effects are
  observed by the focused lifecycle tests; the value harness refuses unobserved
  host writes or resource/callback lifecycles. Current ABI metadata is checked
  against an emitted manifest, and pending inventory must exactly match files.

## Text traversal

`Text.lines`, splitting, and replacement carry byte positions between matches.
Three raw UTF-8 operations supply byte length, boundary-checked slicing, and
search from a byte position; public scalar-indexed operations keep their
meaning. Slices retain their owner and replacement performs one final join.
Deterministic emitted-instruction checks bound successive search work and
require constant-work boundary validation. Unicode, absent/empty/dense
delimiters, growing replacement, trailing fields, and invalid boundaries have
evaluator/Wasm tests.

The original 4,096-delimiter measurement fell from 59.438 ms to 0.185 ms for
`lines`, and from 43.687 ms to 0.234 ms for `replace` on the final artifact.
These are local observations using the triage's compile-once, three-warmup,
seven-call protocol, not portable timing gates. The repeatable command is:

```sh
node --import tsx experiments/performance-pathologies/text_composition.ts
```

## Source libraries and concrete follow-ups

`blot:pipeline` maps, filters, and folds with effectful callbacks. `Array.find`
stops at the first match; `Iter.map` retains a lazy state/step protocol. Tests
check callback order, empty inputs, early exit, suspended calls, cancellation
draining, and borrowed-state rejection.

`blot:parse` parses signed runtime integers in bases 2–36, with explicit sign,
complete-input, and overflow policy. Errors distinguish empty input, invalid
radix, invalid scalar and position, and overflow position. Wasm tests cover both
signed limits, every radix, randomized round trips, Unicode errors, and 32,768
leading zeros without recursive stack growth.

[Concrete follow-ups](library-followups.md) include an ordinary written module
input bound, an enum/product command codec, and pure source float presentation
for binary32 and binary64. The follow-up also closes inferred recursive search
results, sequences effectful iterator steps with pure bodies, and generalizes
omitted function-header annotations independently. That document records the
contracts, regression coverage, and narrower remaining boundaries. The
measurements below describe the preceding triage artifact; follow-up
verification is recorded separately.

## Development latency

Immutable provenance encodings now have a bounded memo with weak allocation
owners. Source revision digests remain fresh, and portable keys, admission
budgets, and occurrence/effect distinctions are preserved. Small source records
use bounded linear lookup through eight fields and acquire an index above that
size, reducing allocation during capsule reconstruction and invalidation.

The final production artifact is
`0cda8f4e75a7296809500b307ae94577f655b6097177e7213910d3cb341c3086` (7,067,128
bytes). Both 20-edit, 5 MiB acceptance runs pass the unchanged 100 ms p95 and
128 MiB RSS-growth gates:

| Edit pattern |  Median |     p95 | First edit | Maximum | Peak RSS growth |
| ------------ | ------: | ------: | ---------: | ------: | --------------: |
| Unique       | 73.4 ms | 77.6 ms |    69.9 ms | 81.3 ms |         5.6 MiB |
| Alternating  | 85.0 ms | 89.0 ms |    72.3 ms | 90.3 ms |         9.5 MiB |

Each edit transfers one 6,294-byte Wasm provider, retains 19 units, and checks
the newly activated results. All 64 active-graph observations also pass,
including disk restart and shared dependency invalidation. The heavier active
graph still takes 154.0 ms median with memory caching. These are local workload
results, with unrelated CPU activity, rather than a universal latency guarantee.
[The latency review](../experiments/development-bench/latency-review.md) retains
the profiles, paired comparisons, earlier failed gate, and reproduction
commands.

## Verification

The final artifact has compiler host ABI 9, certificate schema 22, and Runtime
HIR schema 14. The guest ABI remains 4. Compiler and package builds pass, as do
the six distribution checks.

- 572 native Rust tests.
- 284 Node tests, two Web Worker tests, and 1,693 adjacent regressions in 81
  files.
- 32 typed evaluator/Wasm conformance cases and all 230 accepted corpus
  programs.
- Typechecking, formatting, Deno lint, Clippy with warnings denied, current
  metadata, language health, compiler schema, and QCore checks; regenerated
  parser files match byte for byte.
- Emitted memory-lifetime checks cover allocation, canonical adapters, frames,
  managed collections, and bounded 100,000-iteration workloads. The guest ABI
  audit checks 66 administrative calls.
- All 41 game compiler probes report `supported: true`, including the original
  five failures, and record the final compiler digest.

The full game verification command passes asset generation, 44 unit tests,
typechecking, the production build, and all 33 browser scenarios. Chromium
closed during the first run; the focused retry and full rerun both passed with
process diagnostics enabled and no game source changes. Generated Blender-file
changes from those commands were restored; the game working tree is clean.

CI lint required mechanical cleanup in the preceding refinement/cache edits; the
rarely populated boxed environment index retains its storage rationale. After
that cleanup, native tests, Node tests, typed conformance, corpus compilation,
memory/ABI audits, package checks, all game probes, and both development
benchmarks were rerun. The resulting game Wasm is byte-identical to the full
browser-tested artifact (SHA-256
`252002c3e2f95c9c634030f6e951ec13091468a6b2bafad17ef2ff5f1d823855`). The full
adjacent regression suite and Web Worker tests passed before this mechanical
cleanup.
