# Language and compiler triage — 2026-09-12

The next compiler work should make imported handler builders compose correctly
and remove repeated text scans from splitting and replacement. Several older
“not implemented” entries describe features that now exist. The selected syntax
improvements are useful, bounded surface changes; none requires a new runtime
encoding.

This is a review of the current working tree, not a claim about pristine main.
The subsequent [implementation ledger](triage-implementation.md) records which
findings have been fixed and their fresh acceptance results. Measurements below
describe the review baseline. Its base is
`ee6bfb96c515b47b492490c077815c062d5c0c21`; it includes the preceding
refinement, cache, and regression repairs. Fresh semantic probes used production
compiler SHA-256
`e7e55042947bbc3c4c74f99c89da6f54aebd32ed1a5add8a0a4694113b50a049`, with
compiler input identity
`918639c742db25d64a3aabd3a9698fcd7ed7ed80b98834b3c40adb6939e10fa1`. The compiler
artifact has host ABI 8; the guest ABI is 4. These are distinct contracts.

## Fixable issues to prioritize

| Priority | Finding                                                              | Decision and completion boundary                                                                                                            |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Imported handler builders fail continuation checking                 | Fix compiler provenance and checked ownership evidence. Local and imported builders must behave alike without weakening continuation rules. |
| P1       | `Text.lines` and `Text.replace` scale quadratically on dense matches | Fix the composition of cursor, search, and slice operations. Protect total traversal work, not just the substring-search kernel.            |
| P2       | Current-status metadata and pending inventory are stale              | Derive or cross-check ABI claims against the emitted contract, and require the pending expectation map to match the files.                  |
| P2       | Conformance uses display text as value equality                      | Compare typed observations; test display formatting separately. Preserve F32 rounding, signed zero, variants, ownership, and effect traces. |
| P2       | Development reload latency still misses its absolute gate            | Continue profiling retained compiler evidence. Preserve dependency identity and invalidation correctness.                                   |

### Imported handler builders: a real compiler defect

The existing
[stream combinator experiment](../experiments/next-feature/effect_stream_combinators.blot)
imports builders from
[effect_stream_support.blot](../experiments/next-feature/effect_stream_support.blot).
Both `.emit` clauses explicitly bind `?resume`. Checking this additional module
beside them still fails:

```blot
const stream = import "./effect_stream_combinators.blot"
return stream.run 3
```

Expected: `30`. Observed:

```text
BLOT_HANDLER_RESUME_NOT_AFFINE:
Handler clause `.emit` must bind its continuation as `?resume`.
```

In `compiler/src/typecheck.rs`, `require_continuation_qualifier` takes a
closure's parameter ID but indexes the caller-supplied module arena. The closure
retains its defining provenance; the check does not use it. A foreign ID is not
a local pattern ID. Separately, `require_continuation_ownership` in
`compiler/src/ownership.rs` expects a source-local handler record when the
computation is linear. Fixing only the first lookup leaves that limitation.

Carry checked continuation qualifiers and usage obligations with the defining
clause, including through module capsules. Both checking and ownership should
consume those facts with their source provenance. Update the relevant compiler
contracts and certificate versions if the serialized evidence changes.

Acceptance should cover local/imported/aliased builders, source edits and
capsule reuse, affine and linear resumptions, cancellation, and negative
duplication or abandonment cases. Execute a dynamic exported `run` as well as
the constant wrapper above, and require evaluator/Wasm agreement. This unlocks
ordinary library stream, state, and tracing combinators. It needs no `yield`
syntax.

### Composite text operations: a remaining runtime pathology

Fresh emitted-Wasm measurements passed dynamic text to these exports:

```blot
open import "blot:prelude"

const lines :: Text -> Int
const lines = fn text => Array.length (Text.lines text)

const replace :: Text -> Int
const replace = fn text => Text.length (Text.replace (text, "\n", "|"))

const length :: Text -> Int
const length = fn text => Text.length text

return { .lines = lines; .replace = replace; .length = length; }
```

The input is `"a\n".repeat(n)` in the host. Compile and instantiate once, warm
each export three times per size, then take seven calls and report their median.
Each call must return `n + 1` for `lines` and `2 * n` for the other exports.
Compilation, warmup, and result assertions are outside the measured intervals;
the calls include canonical host argument and result adaptation. The host was
Node 24.12.0. These local timings are evidence of the scaling curve, not
portable performance thresholds.

| Delimiters | Input bytes | `lines` median | `replace` median | `length` median |
| ---------: | ----------: | -------------: | ---------------: | --------------: |
|        256 |         512 |       0.298 ms |         0.267 ms |        0.006 ms |
|        512 |       1,024 |       0.903 ms |         0.717 ms |        0.005 ms |
|      1,024 |       2,048 |       3.544 ms |         2.788 ms |        0.007 ms |
|      2,048 |       4,096 |      13.972 ms |        10.694 ms |        0.008 ms |
|      4,096 |       8,192 |      59.438 ms |        43.687 ms |        0.015 ms |

The large-size doubling ratios approach four. Timing alone is not a complexity
proof, but the source explains the result: `text_split_from` and
`text_replace_from` repeatedly call scalar-indexed `text_find_from` and
`text_slice` in [the prelude](../src/prelude/prelude.blot). Their checks and the
Rust primitive/runtime implementations recount the text or walk from its start
to convert scalar positions to byte positions. `Text.lines` uses the splitting
path. The shared Two-Way search kernel is already fixed; restarting conversion
for every match reintroduces quadratic work around it.

Retain validated byte positions between matches and slice at those boundaries,
or build an index once if that is the better measured tradeoff. Reuse the
existing search kernel and preserve public Unicode-scalar semantics. Replacement
already uses a scratch builder and one final join; repeatedly copying its output
is not the demonstrated cause.

Acceptance needs ASCII and multibyte input, dense/absent/empty delimiters,
replacement growth, and empty/trailing fields. Require evaluator/Wasm values to
agree. Add deterministic work accounting for the composite traversal, including
boundary conversion and validation; a wall-clock threshold alone is too noisy.
The current
[search pathology tests](../experiments/performance-pathologies/README.md)
protect the lower-level kernel, not this complete operation.

### Status and conformance need more trustworthy checks

`compiler/current-implementation.json` says public ABI **3**, and its generated
JSON/Markdown repeat that. The emitter and host manifest type say **4**.
`scripts/generate_current_implementation.ts` copies the manual claim without
checking it against an emitted manifest. Correct the authoritative input and
make generation reject a mismatch; editing generated output alone is
insufficient.

Only two files remain under `examples/pending`, but `examples.test.ts` also has
an orphan `collect_principal_type` expectation. The test enumerates files, so
this stale map entry is never exercised. Require inventory equality, and retire
or reclassify the two remaining requests as described below. Keep historical
benchmark results dated; do not present them as current failures.

A fresh scalar-traversal probe also demonstrates a conformance-harness problem:
`collect (Text.scalars "a😀é")` produces the same four strings in evaluator and
Wasm, but the evaluator prints the combining mark as `\u{301}` and the host
printer preserves it literally. The prior arithmetic review likewise found
printer differences for F32 values and record order while typed values agreed.
`scripts/verify_runtime.ts` currently compares those display strings. A shared
observation comparison should respect the declared value representation,
including signed zero and the relevant NaN policy, rather than broaden string
normalization until failures disappear.

### Incremental compilation: improve the measured remaining cost

The latest [latency review](../experiments/development-bench/latency-review.md)
already records a 33.0% median reduction in paired heavy active-graph edits. Its
production alternating-edit runs still have p95 values of 100.7–143.4 ms against
the unchanged 100 ms gate; unique edits measured 94.2 ms. These are existing
measurements, not newly rerun timings in this triage.

Immutable evidence encoding and repeated evidence traversal remain useful
profiling targets. Explore interning or proven dependency projection only with
exact capture, effect-instance, and revision identities preserved. Require
provider-only activation for unchanged interfaces, correct restored caches,
newly activated runtime values, and honest end-to-end latency. Do not turn a
cache collision into a performance optimization or omit semantic work from the
measurement. Splitting development units and retaining unchanged instances
already exist; the next work is reducing the remaining per-edit cost.

## Reclassify completed or stale requests

| Older request or failure                                                                  | Current evidence                                                                                                                               | Triage                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text cannot be decomposed; add `Text.codepoints`                                          | Fresh evaluator/Wasm values agree for `Text.scalars "a😀é"`; `cursor`, `next`, slicing, searching, splitting, trimming, and replacement exist. | Close the original capability request. The name `codepoints` is still absent; numeric scalar values would be a distinct API decision. Scalar traversal is also distinct from grapheme segmentation. |
| Float comparison must return `#Unordered`                                                 | Fresh `Float.F64.partial_cmp` from `blot:float` returns `#Unordered` in both executions. `F64.cmp` still intentionally traps on NaN.           | Reclassify the pending probe. An explicit unordered result is partial comparison; a true total order over NaNs and signed zeros is a separate, deferred design.                                     |
| `collect` has the old widened principal type                                              | The promoted catalog program evaluates and emits `[0, 1, 2, 3]`; the stale pending expectation has no file.                                    | Remove the orphan inventory entry. Keep the existing principal-type regression authoritative.                                                                                                       |
| Static captures alias one residual body                                                   | The historical `static_captures.repro.ts` now returns the expected `49`; residual identity tests pass.                                         | Close the reproduced bug. Keep capture permutations and module provenance in cache regressions. Update the stale caveat in `blot:derive` when revisiting its API.                                   |
| Compile-time and runtime attached operators disagree                                      | The historical `operator_coherence.repro.ts` passes, as do current language-claim tests.                                                       | Close the demonstrated phase mismatch. Float `==`/`!=` remain intentionally absent.                                                                                                                 |
| An effectful module result, agent recursion, or owned radix sort blocks compilation       | All three targeted historical regressions pass.                                                                                                | Close those recorded blockers. Their historical reports need a pointer to the newer result.                                                                                                         |
| Static product fields use the wrong order                                                 | The focused static-product-layout regression passes.                                                                                           | Close the recorded layout blocker; the fresh test establishes compilation, not every possible static layout.                                                                                        |
| Deep record layout, adversarial substring search                                          | Current focused tests pass, including nested depth 32 and repetitive/Unicode searches.                                                         | Keep their deterministic guards. This does not close the separate composite text issue above.                                                                                                       |
| Diamond imports expand exponentially; wide refresh exhausts descriptors                   | Seven current loader tests pass, including depth 32 and a 512-file refresh under a 64-descriptor limit.                                        | Close those demonstrated host pathologies; retain invalidation and error-draining checks.                                                                                                           |
| Expression holes need an `@hole` primitive                                                | A fresh native `_` probe reports `BLOT_EXPRESSION_HOLE` with expected `Int`; editor support already exists.                                    | Keep native holes. The legacy unknown-primitive test is not coverage of native hole behavior.                                                                                                       |
| Need explicit async execution context, channels, events, parallel Sparks                  | The implemented scope/executor APIs and their validation are recorded in [Spark implementation](spark-implementation.md).                      | Build useful applications on these APIs. The remaining handler provenance bug does not justify another scheduler model.                                                                             |
| Need open effect rows, explicit filtering loops, typed record spread, affine result facts | These are implemented and specified; current language-claim and refinement regressions cover their boundaries.                                 | Use the current specification and examples instead of the older suggestion text. Do not claim unrestricted row polymorphism or general SMT inference.                                               |

## Features worth adding

| Feature                                        | Can it fit?                                                                                             | Recommended scope                                                                                                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct parameter and result annotations        | Yes, as surface constraints on ordinary functions.                                                      | Adopt the selected direction: `fn (a :: Int) -> Int => do:`. Keep separate whole-binding signatures and explicit `do:` for statement bodies. Settle tuple/destructuring patterns, qualifiers, effect rows, recursion, and polymorphism in the Baba prototype. |
| Record value shorthand                         | Yes, ordinary field construction after elaboration.                                                     | Add `.run;` meaning `.run = run;`, preserving name lookup, duplicate detection, staging, and ownership. Keep explicit renames.                                                                                                                                |
| Newline boundaries for multiline record fields | Likely, subject to a conflict-free layout experiment.                                                   | A field at the record's field indentation ends the previous field; preserve continuations, nested suites, and explicit separators on one line. Do not insert semicolons indiscriminately.                                                                     |
| Effectful pipeline adapters                    | Yes, source already demonstrates it.                                                                    | Generalize the pure callback contracts in `blot:pipeline` using existing effect rows. Check effect order, cancellation, ownership, and public schemes. A fresh source-defined `map_with` performing a local effect returns `9` in both executions.            |
| `Array.find` and `Iter.map`                    | Yes, ordinary source over existing traversal protocols; these members are absent.                       | Add small functions with explicit borrowing/consuming behavior and early-exit/effect tests. Lazy iterator mapping should retain one state/step protocol, not allocate a new closure per element.                                                              |
| `Option.map` and `Result.map`                  | Already implemented, including related chaining functions.                                              | Retire the missing-feature claim in the old suggestions.                                                                                                                                                                                                      |
| Runtime integer parsing                        | Yes, now that scalar traversal exists. No new parser primitive is justified by the old text limitation. | Add an optional source library with explicit radix/sign/whitespace policy and structured invalid-digit/overflow results. Prove safe accumulation before arithmetic.                                                                                           |
| Float-to-text conversion                       | Still missing from the public numeric/text surface.                                                     | Specify useful formatting and round-trip behavior first, including special values and signed zero. Prototype source capability; add a narrowly justified primitive only if existing operations cannot meet that contract.                                     |
| Written module-input contracts                 | The header currently binds an unannotated pattern.                                                      | Revisit after typed patterns; share their constraints if an explicit input header is still needed. Keep inferred authority demand checked against the written upper bound.                                                                                    |
| Broader derivation and codecs                  | Current `blot:derive` supports a narrow scalar/product fragment.                                        | Start with a concrete enum/product codec and checked field/constructor evidence. The static-capture fix helps, but does not authorize duplicating owned fields or opening private constructors.                                                               |
| Better highlighting and example layout         | Yes, using existing syntax and checked facts.                                                           | Capture field names precisely, distinguish keywords from members such as `.return`, and format long signatures/record fields coherently. Do not infer a separate type namespace from capitalization.                                                          |

For all three syntax changes, require successful Baba generation with the
version-3 general profile, all rules as islands, no parser resolutions, and
recorded counter changes. Update `LANGUAGE.md`, the relevant frontend contract,
formatter, highlighting, and executable examples in the same implementation. The
[visual review](../experiments/visual-language/README.md) records the selected
examples. This review corrects stale `do:` documentation; it does not implement
those proposed grammar changes.

## Limits to retain and ideas to defer

- **Persistent copies are sometimes required.** Retaining old arrays makes their
  versions observable. Use consuming arrays, builders, cursors, or disjoint
  `Slice` regions where the algorithm permits them; do not silently recover
  unique authority from shared values. The [memory guide](algorithm-memory.md)
  identifies which examples already have the right cost boundary.
- **Keep intentional bad algorithms as examples.** `pathological_fibonacci`
  deliberately makes exponential calls. The small compile-time `sort_by` uses
  stable insertion sorting. Measure a realistic declaration workload before
  changing the latter. Neither is evidence for implicit memoization or changed
  integer-overflow semantics.
- **Do not add Store capacity everywhere preemptively.** Scratch already has
  reserved-capacity builders, and owned paths can reuse storage. Measure
  allocation fallback/copying on interleaved growth before changing the general
  representation. Private allocation capacity and public sequence length are
  different contracts.
- **Keep ownership restrictions across suspension.** Borrowed values live across
  suspension and linear host transfers without a supported cleanup protocol
  remain restricted. The current backend refuses resumable artifacts with linear
  host transfers. Ordinary scoped cleanup and affine transfers do not establish
  the missing linear transfer protocol.
- **Keep closed public layouts.** Open function choices, deferred computations,
  `Scratch`, and private `Region` values cannot simply cross the ABI. Finite
  internal function choices are already defunctionalized. Broaden the public
  boundary only for a concrete host interoperability requirement.
- **Defer unrestricted liquid/SMT inference and termination proving.** Bounded
  relational result facts and direct self-tail loop inference already work. Add
  a new proof fragment when a real safe program needs it, with overflow,
  provenance, budget, and certificate replay accounted for.
- **Defer a full unsigned word domain.** `U64` describes storage bounds;
  ordinary runtime integers remain signed 64-bit. Values above that domain need
  distinct operations and representation, not a renamed `Int` or silent
  wrapping. Pursue this for a demonstrated binary-format, hashing, or numeric
  workload.
- **Defer a new concurrency syntax or compiler encoding.** Explicit I/O,
  one-shot continuations, scopes, channels, and workers are present. The
  concrete problems above concern provenance and repeated work within the
  existing model. A new encoding should demonstrate a measurable benefit and
  preserve compiler pass obligations before it displaces this one.
- **Grow proofs at concrete boundaries.** Checked evidence and local mechanized
  models are valuable but do not imply a proved whole compiler. Prioritize
  ownership through desugaring, relational frame conditions, capsule replay, and
  cancellation obligations alongside the code that changes them.

## Suggested implementation order

1. Repair the status inventory and typed observation comparison so future
   feature work has trustworthy acceptance criteria.
2. Fix imported handler evidence and its ownership consumers; promote the stream
   experiment only after both executions and negative ownership cases pass.
3. Make composite text traversal linear in scanned input plus output work, with
   deterministic work checks and a replay of the dense-delimiter measurements.
4. Implement typed parameters, record shorthand, and multiline field boundaries
   as separate verified grammar changes. Keep `fn`, separate binding signatures,
   and explicit `do:` for statement bodies.
5. Add the small library APIs and representative stream/text applications. Let
   their usage determine the next codec, formatting, or module-contract feature.
6. Continue the development-latency work against its existing gate, preserving
   correctness and cache identity. Larger representation work remains contingent
   on profiles and concrete unsupported programs.

## Fresh verification for this triage

The following focused checks passed: 29 tests across performance pathologies,
language claims, and residual identity; three historical blocker tests; one
static-product-layout test; and seven loader pathology tests — **40 tests**.

```sh
pnpm exec tsx --test src/node/performance_pathologies.test.ts src/node/language_claims.test.ts src/node/residual_identity.test.ts
pnpm exec tsx --test --test-name-pattern='a module may directly return an effectful computation|agent-style recursion remains dynamic runtime control flow and compiles|owned radix sorts preserve signed order and stable equal-key order' src/node/pipeline.test.ts
pnpm exec tsx --test src/compiler/static_product_layout.test.ts src/load_pathologies.test.ts
pnpm exec tsx experiments/language-review/static_captures.repro.ts
pnpm exec tsx experiments/language-review/operator_coherence.repro.ts
```

Eight focused source probes checked the two pending entries, scalar traversal,
partial float comparison, imported handlers, an effectful pipeline adapter,
native holes, and the promoted `collect` example. Errors are classified above;
they were not counted as successful feature implementations. The text timing
probe checked every runtime result. All 15 corrected/new specification snippets
passed Baba parsing with illustrative context supplied where needed; the named
effect row and separate signature also compile. The visual comparison passed
seven selections at two widths in two themes, including its color toggle.

No compiler semantics were changed for this triage, and the compiler was not
rebuilt again for documentation edits. The preceding full compiler/game results
remain recorded in the latency review; the fresh focused checks above are not a
claim that those full suites were rerun here. The fixes in this report remain
implementation work.
