# Example PR triage — 2026-09-13

## Implementation follow-up — 2026-09-14

The integrated branch includes example PRs #119–#135 and the completed retained
state-loop work from main. The original observations below remain a historical
record of the September 13 baseline. The compiler and example updates address
these separate obligations:

| ID   | Implemented change                                                                                                          | Regression boundary                                                                                                  |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| PP01 | Higher-order application checks the original callback relationship before specialization.                                   | Wrong fold elements and incompatible projections reject during checking.                                             |
| PP02 | Computed closures preserve checked input/result relationships; generated monomorphic methods retain their schema contracts. | Unannotated parser and keyed-index results, a forwarded structural differ, and incompatible generated-method inputs. |
| PP03 | Open effect constraints retain the inherited rigid tail.                                                                    | Generic `instrument` accepts pure and effectful callbacks; dropping the callback's effect still rejects.             |
| PP04 | Closed tuple parameter evidence reaches nested case checking.                                                               | Semiring operations no longer repeat parameter annotations; missing constructors still reject.                       |
| PP05 | Universal signatures provide fresh quantified context while checking their implementation.                                  | Nonempty length accepts its explicit generic signature; an invalid universal implementation rejects.                 |
| PP06 | Immutable guard refinements follow the binding and field path.                                                              | Validation reads refined fields directly; another field gains no evidence.                                           |
| PP07 | Generic failures retain source evidence at the application; open-export refusals name the export and parameter.             | Fold source spans, mismatched library arguments, and an intentionally open exported comparator.                      |
| PP08 | Nested constructor payload unions print with parentheses.                                                                   | Prism and codec principal types preserve visible grouping.                                                           |
| PP09 | Failed Baba continuations receive a token span and accepted spelling.                                                       | Newlines after `=>` suggest `do:`; continued unions suggest parentheses. Syntax acceptance is unchanged.             |
| PP10 | `format` and `format:check` run without the semantic compiler; CI checks changed Blot files early.                          | CLI check/write, malformed-source preservation, and the merged example catalog.                                      |

The quantity example now uses singleton unit labels with typed descriptors and
rejects cross-unit arithmetic. Readers compose record schemas with spreads.
Parser, index, validation, middleware, semiring, and structural-diff examples
exercise the repaired forms. Their useful public contracts and ownership
requirements remain explicit.

Integration also exposed residual representation defects: nested closures must
use facts from their own specialization, array evidence must include every
member, incomplete constructor payload evidence must remain unknown, and type
unions must normalize before representation selection. Regression coverage
includes record selection, suspended aggregate state, iterator erasure, and the
engine's scalar/SIMD component stores. Fused source-effect queries keep the
caller's handler frame, and fresh message-array updates use their lowered
ownership evidence instead of falling back to persistent copies.

Record arguments retain fields outside a checked parameter row, including when
an outlined function would otherwise narrow their runtime layout. Recursive
bindings preserve deferred calls. `Shape.update` and `Shape.entries` traverse
known field names while their values remain dynamic; the runtime fixture checks
extra-field preservation, patches, and ordered field enumeration. ECS systems
explicitly project their declared read fields with `Reflect.pick`, so reflection
inside a callback cannot observe undeclared components. Development-unit
boundaries also recheck open provider signatures with cyclic inference evidence
against their actual arguments, so inferred aggregate results keep a concrete
reload interface. Generic identity links retain sealed argument representations.

The request-builder and codec PRs add no further confirmed compiler defect to
this list. Generic consuming transitions still need a proven ownership relation;
codec `Result` products intentionally return the first failure. Quantifier
shorthand, codec laws, broader reflection, opaque APIs, and algorithmic costs
remain separate design or library topics, as distinguished in the original
triage. The implementations do not weaken ownership to remove those boundaries.

Compiler regressions live in
[`compiler/src/abstraction_tests.rs`](../compiler/src/abstraction_tests.rs).
[`scripts/check_abstractions.mjs`](../scripts/check_abstractions.mjs) includes
all of these example suites with a process timeout per suite. Integrated
verification covers 610 Rust compiler tests, 354 Node tests, all 86 regression
suites (including 28 ECS tests), all 256 catalog programs, the abstraction
suites, and evaluator/Wasm conformance. Formatting, TypeScript checking, Wasm
Rust lint, generated frontend/health checks, memory checks, guest ABI checks,
and package checks also pass. Historical test counts below refer only to the
original review.

An additional native `cargo clippy --all-targets -- -D warnings` run reports
existing `large_enum_variant` (`hir.rs`), `items_after_test_module`
(`safety.rs`), and `collapsible_if` (`session.rs`) warnings. These are outside
the configured Wasm lint target and remain unchanged.

## Original triage

Fix the checker/compilation disagreement and lost generic result types first.
Most submitted examples can merge with their explicit type boundaries while
those compiler fixes proceed separately. Quantities and structural Readers need
source changes before merging. The updated structural-diff PR passes its focused
checks with its explicit ownership copy.

This review covers PRs **#119–#133**, at the heads recorded below, against
`main` **b2173fb28019fa4555cb2ad2a663963792ea3899**. The Rust/Wasm compiler
SHA-256 is **011dc1d8eee32e2f0b6d7f51ee3ead1986cc73f76309fef3b07eeba45e0b9827**.
PR #133 appeared and was updated during the review; its final reviewed head is
recorded below. No PR was merged, edited, approved, or commented on during this
triage.

The review used PR descriptions, exact source revisions, current CI logs, and
fresh compiler observations. Reported failures were reproduced separately from
the submitted working examples. Successful annotated examples do not establish
that their unannotated alternatives work. Conversely, red CI is not by itself
evidence of a compiler defect.

## Deduplicated fix list

Priorities describe the order of this work, not a claim about exploitability. P1
concerns incorrect checking results. P2 concerns rejected valid abstractions,
misleading diagnostics, or repeated development friction.

| ID   | Priority | Valid finding                                                                                                 | PRs                                                                                                                                                                                                        | Completion boundary                                                                                                                       |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| PP01 | P1       | Checking loses the relationship between a fold's element type and its callback input.                         | [#128](https://github.com/mewhhaha/blot/pull/128)                                                                                                                                                          | Reject the bad argument during `check`, with caller evidence; retain valid polymorphic folds.                                             |
| PP02 | P1       | Generic composition publishes bottom payload types despite producing inhabited values.                        | [#130](https://github.com/mewhhaha/blot/pull/130), [#131](https://github.com/mewhhaha/blot/pull/131), [#133](https://github.com/mewhhaha/blot/pull/133)                                                    | Preserve input/result relationships without extra concrete result annotations; check inferred types as well as both executions.           |
| PP03 | P2       | A named generic composition of row-preserving middleware loses its open effect tail.                          | [#127](https://github.com/mewhhaha/blot/pull/127)                                                                                                                                                          | Accept `traced (counted operation)` under its written open-row signature; retain all three effects and reject dropped effects.            |
| PP04 | P2       | Tuple destructuring does not supply enough signature context before nested exhaustiveness checking.           | [#129](https://github.com/mewhhaha/blot/pull/129)                                                                                                                                                          | Accept the tupled `Cost` operation without local type rebindings; still reject genuinely missing cases.                                   |
| PP05 | P2       | A universally quantified array-length wrapper is rejected after its inferred input widens to `[⊤]`.           | [#124](https://github.com/mewhhaha/blot/pull/124)                                                                                                                                                          | Check the wrapper under its quantified element context; do not make mutable arrays covariant to force acceptance.                         |
| PP06 | P2       | Refinement evidence does not follow repeated immutable field projections.                                     | [#126](https://github.com/mewhhaha/blot/pull/126)                                                                                                                                                          | Carry facts for the same binding and field path; preserve rejection for different paths and invalid values.                               |
| PP07 | P2       | Generic argument errors point into library bodies; open exported functions receive unhelpful target refusals. | [#123](https://github.com/mewhhaha/blot/pull/123), [#128](https://github.com/mewhhaha/blot/pull/128), [#129](https://github.com/mewhhaha/blot/pull/129), [#130](https://github.com/mewhhaha/blot/pull/130) | Show the incompatible caller argument and the originating constraint; identify an unrepresentable exported field and its open input type. |
| PP08 | P2       | Type printing erases the visible grouping of nested constructor payload unions.                               | [#132](https://github.com/mewhhaha/blot/pull/132)                                                                                                                                                          | Print unambiguous parentheses without changing type semantics.                                                                            |
| PP09 | P2       | Multiline expressions produce opaque island errors instead of useful layout guidance.                         | [#120](https://github.com/mewhhaha/blot/pull/120), [#122](https://github.com/mewhhaha/blot/pull/122), [#123](https://github.com/mewhhaha/blot/pull/123)                                                    | Diagnose the unsupported continuation and show an accepted spelling. Decide separately whether to extend continuation syntax.             |
| PP10 | P2       | Blot formatting and stale generated metadata surface late or repeatedly during example work.                  | [#119](https://github.com/mewhhaha/blot/pull/119), [#123](https://github.com/mewhhaha/blot/pull/123), [#128](https://github.com/mewhhaha/blot/pull/128)–[#133](https://github.com/mewhhaha/blot/pull/133)  | Provide an early syntax-only Blot format check and keep generated inventory current before branch validation.                             |

These are separate acceptance obligations. Similar generic symptoms may share a
cause, but this review does not establish that one inference patch fixes all of
them.

### PP01: successful `check`, then a source type failure

The [standalone fold probe](../experiments/pr-triage/fold_input.blot) is:

```blot
open import "blot:prelude"
const add: (Int, Int) -> Int
const add = fn (sum, value) => sum + value
return fold (["oops"], 0, add)
```

Current checking succeeds with `Int`. Evaluation and compilation both fail with
`BLOT_TYPE: @int.add expects an integer, found "oops"`, attributed to the
prelude. The PR's `R.run` version behaves the same way. No invalid Wasm is
emitted in these reproductions; the defect is that the checking boundary
accepted an incompatible argument. A concrete application wrapper currently
protects the submitted reducer example.

### PP02: principal types exclude observed results

Removing only the three `Option Text` result signatures from #130 yields
`#None | #Some ⊥` for each lookup. Evaluation and Wasm still produce
`#Some "Ada"`, `#Some "compiler"`, and `#None`.

The small parser from #131 checks as `{ .default = #Error ⊥ | #Ok ⊥ }` and
executes as `#Ok #Health`. Removing the submitted `user` and `route` signatures
also fails downstream at `parse_route` with
`{ .offset = ⊥ } does not flow into { .expected = Text }`.

A [self-contained reduction](../experiments/pr-triage/generic_result.blot) needs
no parser library or text cursor: mapping a signed parser checks as
`#Error ⊥ | #Ok { .value = ⊥; .rest = ⊥ }` and produces a record containing
`#Health` and `""`. This is more than inconvenient printing or an intentionally
open public input. The printed result excludes an inhabited payload. A simpler
lookup without the nominal-key dictionary inferred `Text` correctly, so keep the
full #130 reproduction when fixing it.

The updated #133 adds another confirmed instance: wrapping `Diff.derive` with
`fn derive => fn schema => derive schema` changes its deployment change lists
from `[Text]` to `[⊥]` during checking. Both executions still return the field
names. Retain this schema-indexed higher-order case alongside the parser and
index cases; direct static derivation is the submitted working form.

### PP03–PP06: conservative rejection of useful source

- [Effect composition](../experiments/pr-triage/effect_composition.blot): the
  signed generic `instrument` still fails with a rigid effect variable not
  flowing into `{ ..⊥ }`. The PR's concrete composition preserves Fetch, Trace,
  and Metrics, and its dropped-Fetch fixture remains rejected.
- [Tuple cases](../experiments/pr-triage/tuple_case.blot): the inner
  `case right` sees `⊤` despite `(Cost, Cost) -> Cost`. The
  [curried control](../experiments/pr-triage/control_tuple_case.blot) succeeds
  and returns `#Some 3` in both executions.
- [Quantified length](../experiments/pr-triage/quantified_length.blot): the
  failure reduces beyond NonEmpty to `forall T. [T] -> Int`. Explicitly
  borrowing the function parameter does not fix it. This deserves contextual
  checking investigation rather than dismissing the annotation as unnecessary;
  the observation does not justify changing array variance.
- [Projected refinement](../experiments/pr-triage/projected_refinement.blot):
  guarding `raw.port` and returning `#Some raw.port` still reports
  `Int does not flow into 1..65535`. The actual #126 `#Ok raw.port` rewrite
  fails too.
  [Binding an alias first](../experiments/pr-triage/control_refinement_alias.blot)
  works. A superficially similar probe using the generic `Some` function passes;
  it does not close the failure of the direct constructor form.

### PP07–PP09: diagnostics and presentation

#129's wrong matrix carrier is rejected at
`examples/lib/semiring_matrix.blot:22:5`; #130's wrong key is rejected at
`examples/lib/nominal_index.blot:19:112`. Preserve those real constraint origins
as secondary evidence and add the caller's instantiation path. Do not replace
source evidence with a synthetic offset-zero error.

The unannotated mixed comparator from #123 checks as
`{ .compare = ⊤ -> ⊤ -> #Less | #Equal | #Greater }` and then receives a target
refusal about `"function"`. That is not evidence that incompatible comparators
are safely callable. Keep algebraic subtyping; make the refusal identify
`.compare`, its input, and the need for a concrete public boundary.

The [printing probe](../experiments/pr-triage/nested_variant_display.blot)
defines two differently grouped types. Their identity functions print the same
type string. The actual prism example likewise visually flattens the cases
inside `#User`. This can be fixed in the printer without changing inference.

[A newline after `=>`](../experiments/pr-triage/multiline_lambda.blot) and
[a vertically continued union](../experiments/pr-triage/multiline_union.blot)
still fail. The
[explicit `do:` control](../experiments/pr-triage/control_multiline_lambda.blot)
works. Improving diagnostics and documenting that spelling is immediately
actionable. Accepting additional continuations is a language-design choice: Baba
must remain the syntax authority, its profile must pass without resolution
overrides, and LANGUAGE/formatter/editor coverage must change together.

## PR readiness and concrete cleanup

“Ready after baseline checks” means the source passed this focused current-main
review, not that an untested merge commit has passed all CI. Shared catalog and
showcase edits still need to be accumulated without dropping entries.

| PR                                                                  | Reviewed head  | Current-main observation                                                                                   | Recommended next step                                                                                                              |
| ------------------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| [#119 — offsets](https://github.com/mewhhaha/blot/pull/119)         | `ffbf73ab0a1a` | Check, both goldens, and formatting pass.                                                                  | Ready after baseline checks.                                                                                                       |
| [#120 — transitions](https://github.com/mewhhaha/blot/pull/120)     | `0d4c1140c560` | Check, both goldens, and formatting pass.                                                                  | Ready after baseline checks; consolidate repeated layout reports.                                                                  |
| [#121 — quantities](https://github.com/mewhhaha/blot/pull/121)      | `aa9baab2730c` | Parsing fails in `quantity.blot`; the rejection fixture fails there too.                                   | Hold. Rename the reserved `of` binding, then resolve the separate constructor/type failure and rerun the nominal rejection case.   |
| [#122 — lenses](https://github.com/mewhhaha/blot/pull/122)          | `a791cf00e3ca` | Check, goldens, formatting, and mismatch rejection pass.                                                   | Ready after baseline checks. Lens laws remain an example-testing concern.                                                          |
| [#123 — ordering](https://github.com/mewhhaha/blot/pull/123)        | `e28822bf791d` | Values/rejections pass; `order.blot` is not canonical. CI also failed README formatting.                   | Format the library and README; resolve the README merge conflict.                                                                  |
| [#124 — NonEmpty](https://github.com/mewhhaha/blot/pull/124)        | `5a2e45bc95ba` | Values/rejections pass. The test's `evaluateFile` call omits its required grants argument.                 | Use the current evaluator API in the test; resolve the README conflict.                                                            |
| [#125 — Readers, draft](https://github.com/mewhhaha/blot/pull/125)  | `f228e9d51372` | `Pricing` and `App` construction fail with `BLOT_EMPTY_TYPE`.                                              | Replace the unsupported record-intersection claim with schema spread; fix the analogous negative fixture and format `reader.blot`. |
| [#126 — validation](https://github.com/mewhhaha/blot/pull/126)      | `e02b7d4d0439` | Submitted alias-based version and rejection fixture pass.                                                  | Ready after baseline checks; track PP06 independently.                                                                             |
| [#127 — middleware](https://github.com/mewhhaha/blot/pull/127)      | `1bc67729d29c` | Concrete composition, goldens, and dropped-effect rejection pass.                                          | Ready after baseline checks; track PP03 independently.                                                                             |
| [#128 — reducers](https://github.com/mewhhaha/blot/pull/128)        | `5e10f2111c50` | Submitted signed version and focused tests pass. CI stopped at stale health metadata.                      | Resolve the README conflict and baseline metadata; retain PP01 as a compiler task.                                                 |
| [#129 — semirings](https://github.com/mewhhaha/blot/pull/129)       | `3d3f679e9734` | Submitted rebindings, goldens, and rejection fixtures pass. CI stopped at stale health metadata.           | Ready after baseline checks; retain PP04/PP07.                                                                                     |
| [#130 — keyed index](https://github.com/mewhhaha/blot/pull/130)     | `b67ffa40764d` | Submitted result annotations, goldens, and wrong-key rejection pass. CI stopped at stale health metadata.  | Ready after baseline checks; retain the exact unannotated PP02 reproduction.                                                       |
| [#131 — parsers](https://github.com/mewhhaha/blot/pull/131)         | `e419253961b4` | Submitted annotations, goldens, and result-mismatch rejection pass. CI stopped at stale health metadata.   | Ready after baseline checks; retain PP02.                                                                                          |
| [#132 — prisms](https://github.com/mewhhaha/blot/pull/132)          | `9efa8085b49c` | Values, principal-type assertion, formatting, and rejection pass. CI stopped on inherited Rust formatting. | Rebase onto the already-formatted main; retain PP08.                                                                               |
| [#133 — structural diff](https://github.com/mewhhaha/blot/pull/133) | `ab5613f2de4b` | Updated ownership copy, goldens, type assertion, and all three focused tests pass.                         | Ready after current-head CI and baseline checks; retain its higher-order PP02 reproduction.                                        |

### Quantities require more than a syntax repair

Renaming `let of` to an ordinary identifier gets #121 past parsing, but then
`To.of` fails with `Type does not flow into Sealed:Centimeters`. The
[small sealing probe](../experiments/pr-triage/runtime_seal.blot) reproduces the
same limitation with a fixed name and an explicit `Int -> Meter` signature;
calling the primitive directly does not help. A generic constructor can instead
publish `Type | Sealed:Meter` and reach a target refusal for an open input.

This is a demonstrated blocker, but the repair needs an explicit decision about
runtime nominal construction versus compile-time type sealing. The current
primitive is documented as a type operation. Do not count the PR's nominal
safety fixture as passing, or promise that a formatting change fixes it. A
supported tagged-constructor design is another possible example direction.

### Reader intersection is an incorrect example claim

LANGUAGE defines `@type.intersect` as intersection of union members; the Rust
primitive implements that contract. It does not merge differently shaped record
schemas. `Left & Right` therefore fails even when the records have disjoint
field names. This is not evidence that width subtyping itself is broken.

Using `{ ...TaxPolicy; ...ShippingPolicy; }` and the corresponding App schema
spread makes the full example evaluate and run as `EUR 12500` and `EUR 11100`.
Updating the missing-capability fixture to use spread then rejects the missing
`.right` at its call site. Rewrite the comments and PR description to explain
the supported schema composition instead of introducing general intersection
machinery to rescue this example.

### Structural diff now has a working ownership path

#133's current `ab5613f2de4b` head copies `names` before appending and updates
its principal-type expectation. The example now checks, matches both goldens,
and passes all three focused tests, including the two intended rejections. Its
initial `40aa63bbe418` draft failed with `BLOT_SHARED_ARRAY_UPDATE`; replacing
only the initial `Array.empty` with a fresh literal did not resolve that
failure.

The submitted copy is a safe implementation, without a performance claim. An
owned accumulator design could avoid repeated copies, but a compiler uniqueness
defect has not been isolated. The refusal to derive arbitrary owned or compound
fields is an existing `blot:derive` boundary, not a bug established by this PR.
The new higher-order result-type failure is tracked under PP02.

## Reports to document or defer

| Report                                                                                 | Disposition                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit borrowing in read-only loops (#119), copying a projected NonEmpty tail (#124) | Preserve ownership rules. Improve examples and diagnostics; do not add implicit moves or infer uniqueness from apparent read-only intent.                                           |
| A total successor predicate at `Int.max` (#119)                                        | The guarded example already handles the boundary. A source helper is possible, but this one use does not justify another primitive or changing checked arithmetic.                  |
| A shared error type in transition chains (#120)                                        | An API choice of this narrow example. Use an explicit error union or mapping; no independent checker defect was established.                                                        |
| Attached namespaces as generic dictionaries (#121, #130)                               | Document explicit type-and-operation descriptors, as the ECS now does. Do not put attached members into structural type equality.                                                   |
| Nested `@forall` binders (#120, #122, #126)                                            | Real readability pressure. Improve formatting/documentation alongside PP09; compact binder syntax requires a separate design decision.                                              |
| Higher-kinded collection contracts and opaque reducer state (#124, #128)               | Broader design proposals, not demonstrated compiler defects. Keep concrete structural boundaries; do not introduce a type-level sublanguage as cleanup.                             |
| Reader projection lambdas and pure Reader (#125)                                       | Ordinary API choices. Field-section syntax or an effect-polymorphic Reader needs an independently useful use case.                                                                  |
| Lens/prism/semiring laws, middleware ordering/cardinality (#122, #127, #129, #132)     | Test behavioral laws with meaningful cases. Function types and effect membership do not claim to prove these equations or execution counts.                                         |
| Comparator-to-sort adapter (#123)                                                      | A small source-library improvement if reuse warrants it; preserve sort stability and ownership.                                                                                     |
| Parser scalar/line/column coordinates (#131)                                           | A useful source-level follow-up: carry positions beside the byte cursor. Byte offset 11 after `/users/🐱` is correct, not broken Unicode traversal.                                 |
| Deriving constructor prisms (#132)                                                     | Worth a bounded reflection prototype after the compiler fixes; require payload checking and exhaustive generated behavior. No new syntax is established as necessary.               |
| Specialization-count advice for deliberate schema generation (#133)                    | Confirmed at two schemas, with severity `hint` and a successful lint exit. Improve its advice or allow local acknowledgement; it is not a measured code-size or runtime regression. |

## Merge and fix coordination

1. **Repair the shared baseline first.** Current main itself fails
   `deno run --allow-read scripts/generate_language_health.ts --check`.
   Regenerate and review the metadata once. #132's inherited Rust-format issue
   is already fixed on this main. Do not copy unrelated compiler changes into
   each example branch to fix historical red CI.
2. **Merge the working examples with their checked boundaries.** Start with
   #119, #120, #122, #126, and #127. Add #129–#133 after rebasing and rerunning
   their focused tests. Preserve the pain-point references; they are not reasons
   to withhold otherwise valid examples.
3. **Make bounded example repairs.** #123 needs formatting, #124 needs its test
   API fixed, and #128 needs a catalog conflict resolved. Their README conflicts
   were verified with `git merge-tree` and are confined to `examples/README.md`.
   Keep #121 and #125 out of that batch until the repairs above are checked.
   Accumulate the shared showcase/README registrations as a union, then run the
   combined catalog and project checks on the actual merge result.
4. **Fix compiler obligations in separate changes.** Start PP01 and PP02, then
   PP03–PP06. Preserve each minimal reproduction and its full PR case. Follow
   with PP07/PP08 and the early feedback work. Update LANGUAGE and the owning
   compiler contracts with semantic changes; compare evaluator and emitted Wasm
   and retain negative cases.

## Evidence and verification limits

- Thirteen of the fifteen reviewed entry programs check, evaluate, and execute
  in Wasm with both recorded goldens matching. #121 and #125 fail. This includes
  the updated #133 head rather than its failing initial draft.
- The original twelve PR-specific Node test files, over current-main compiler
  sources in an isolated checkout, report **25 passed and 5 failed**. Failures
  are the ordering formatter test, two quantity tests, and two Reader tests.
  Their TypeScript check independently finds #124's missing grants argument. The
  updated #133 adds **3 passing focused tests** in a separate run.
- Submitted mismatch fixtures were checked individually. Rejection counts alone
  are not used as evidence: quantity and Reader failures mask their intended
  negative conditions, as the initial diff draft also did.
- [Fifteen standalone probes and controls](../experiments/pr-triage/README.md)
  have [recorded observations](../experiments/pr-triage/results.json), including
  exact source hashes and the compiler identity. The intentional failures are
  evidence, not a passing compiler regression suite.
- The review did not run full CI for fifteen rebased merge commits. CI statuses
  and source heads are a snapshot; recheck them before performing merges.
