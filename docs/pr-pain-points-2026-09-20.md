# PR integration review — 2026-09-20

The review starts from `b8f2a22f`, after committing and pushing the previously
local instruction evaluator and reconciling it with remote main. There were 23
open PRs: 20 abstraction examples, one shared validation repair, one temporary
repair workbench, and one staged-compiler investigation.

Twenty-two PR heads are retained in the integration's merge ancestry. #150 is
closed without merging: its compiler repairs were transferred to their owning
PRs, leaving only a temporary repair-publishing workflow explicitly marked not
for merge. No PR branch is deleted or force-pushed.

## Decisions

| PR                                                | Reviewed head | Decision                                                                                                                             |
| ------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| [#143](https://github.com/mewhhaha/blot/pull/143) | `f27d5ff7`    | Merge the aggregate example, specialization result checks, and caller diagnostics.                                                   |
| [#144](https://github.com/mewhhaha/blot/pull/144) | `dd33039b`    | Merge typed migrations; retain the documented nominal-carrier limitation.                                                            |
| [#145](https://github.com/mewhhaha/blot/pull/145) | `52b25bff`    | Merge shared service contracts and effect/ABI coverage.                                                                              |
| [#146](https://github.com/mewhhaha/blot/pull/146) | `7d49aa88`    | Merge stateful processors and their explicit closed-carrier implementation.                                                          |
| [#147](https://github.com/mewhhaha/blot/pull/147) | `a000e574`    | Merge reversible transitions; inverse laws remain library contracts.                                                                 |
| [#148](https://github.com/mewhhaha/blot/pull/148) | `fb6e4b99`    | Merge zoomable state actions and carrier/refinement rejection tests.                                                                 |
| [#149](https://github.com/mewhhaha/blot/pull/149) | `c6a6c1ac`    | Merge renderable observations and rank-polymorphic consumer checks.                                                                  |
| [#150](https://github.com/mewhhaha/blot/pull/150) | `39181b07`    | Close without merging the temporary repair-publishing workflow.                                                                      |
| [#151](https://github.com/mewhhaha/blot/pull/151) | `04e7c5bc`    | Merge record edits with the reflected-union correction described below.                                                              |
| [#152](https://github.com/mewhhaha/blot/pull/152) | `66767276`    | Merge transducers; retain the generic ownership limitation.                                                                          |
| [#153](https://github.com/mewhhaha/blot/pull/153) | `bf9c2233`    | Merge subtyping witnesses and correct the reflected-union regression notes.                                                          |
| [#154](https://github.com/mewhhaha/blot/pull/154) | `006c3b5e`    | Merge Rank-N interpretable policies and their rejection fixtures.                                                                    |
| [#155](https://github.com/mewhhaha/blot/pull/155) | `1fac7f80`    | Merge bounded domains and stable compile-time integer-bound evidence.                                                                |
| [#156](https://github.com/mewhhaha/blot/pull/156) | `d4f67237`    | Merge typed resource leases and ownership checks.                                                                                    |
| [#157](https://github.com/mewhhaha/blot/pull/157) | `b786c137`    | Merge packed keys; retain the computed word-range limitation.                                                                        |
| [#158](https://github.com/mewhhaha/blot/pull/158) | `783d5457`    | Merge typed retry strategies and effect-row checks.                                                                                  |
| [#159](https://github.com/mewhhaha/blot/pull/159) | `482830fe`    | Merge endpoint adapters and the shared returned-scheme regression.                                                                   |
| [#160](https://github.com/mewhhaha/blot/pull/160) | `c8aa280b`    | Merge dimensional quantities and carrier mismatch tests.                                                                             |
| [#161](https://github.com/mewhhaha/blot/pull/161) | `02134f36`    | Merge the remaining formatter regression; keep main's existing CI repairs.                                                           |
| [#162](https://github.com/mewhhaha/blot/pull/162) | `478681b4`    | Merge nominal domains; retain the projected-eliminator limitation.                                                                   |
| [#163](https://github.com/mewhhaha/blot/pull/163) | `dacc5952`    | Merge service adapters and composition/effect mismatch tests.                                                                        |
| [#164](https://github.com/mewhhaha/blot/pull/164) | `0ad7c718`    | Merge bidirectional bridges and directional compatibility tests.                                                                     |
| [#172](https://github.com/mewhhaha/blot/pull/172) | `0ef7d875`    | Merge the isolated laboratory, frontend migration, and production optimizations; do not claim the original application latency goal. |

## Integration fixes

- The new record-edit example exposed a prelude defect: `refines (T, T)`
  returned false for closed unions, including `Option Text`. The regression
  reproduced against the saved main compiler. Reflection now requires every
  narrow alternative to refine the target, while a wide union still admits any
  matching alternative. Positive identity, widening, record-field and
  integer-range cases and negative direction/payload cases agree in the Rust
  evaluator and emitted Wasm. `LANGUAGE.md` and the witness notes describe the
  corrected public behavior.
- The aggregate and endpoint PRs contained the same returned-scheme regression;
  the integration keeps one copy. Bounded integer evidence uses main's current
  integer representation rather than restoring the older BigInt-only API.
- The instruction evaluator remains the production execution path. The
  persistent effect-scope implementation from #172 replaces the older scope
  structure, and both instruction execution and residual evaluation use the
  shared application preparation and argument-evidence path. Capsule decoding
  preserves the updated scope representation.
- All newly merged examples, fixtures, and inline source signatures use #172's
  single-colon annotations. The migration uses Baba's lexer-backed codemod, not
  an independent parser. Missing showcase registrations are included; generated
  frontend, health, and prelude artifacts are reconciled.
- The isolated prototype imports main's integer representation alongside the
  shared AST. Its test-only MessagePack dependency is pinned to the same version
  already used by the production compiler.

## Boundaries retained

The five new pending examples remain explicit regressions rather than being
silently accepted: nominal migration carriers, projected nominal eliminators,
guarded record arithmetic, generic transducer ownership, and computed packed
word ranges. The abstraction notes and tests document the checked alternatives.

The staged prototype remains opt-in, outside the production compiler entry
points, under [its own contract](../spec/STAGED_PROTOTYPE.md). Its independent
pure fragment is not a production semantic fallback or a replacement ABI.
Neither the private application nor the proposed 100 ms application compilation
goal is established by these synthetic laboratory results.

## Validation

- 741 production Rust tests pass, with one existing ignored test.
- All 432 Node tests and all 57 abstraction-suite files pass.
- All 120 regression files pass, including the formatter, language server,
  example catalog, incremental frontend, and deterministic performance gates.
- The 38 evaluator/emitted-Wasm conformance observations agree.
- Emitted memory-lifetime checks, 71 administrative guest-call checks, both Web
  Worker tests, and all 10 runnable-package checks pass.
- TypeScript checking, Deno lint/format, changed-Blot formatting, both Rust
  format/Wasm Clippy checks, generated artifacts, and the current compiler
  inventory pass.
- All 83 prototype Rust tests pass. The executable Wasm verification performs 40
  process invocations and 100,155 assertions, including repeated export calls;
  that assertion count is not a count of independent test cases.

The integrated compiler Wasm SHA-256 is
`1d25c11dba3a5f60980c2b55a5a0faad042db6268d4709633cd7160392b247d7`.
