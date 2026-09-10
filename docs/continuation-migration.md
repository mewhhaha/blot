# Continuation core migration

Implementation of the September 10 plan. The production Runtime HIR is an owned
continuation graph; block Runtime HIR and its separate suspension plan are
removed. The Baba frontend, structural checker, compile-time evaluator, and Rust
source evaluator retain their semantic roles.

## Agreed contracts

- Join or cancel consumes a Spark job.
- Reload drains and restarts affected scopes; unaffected scopes continue.
- Guest ABI 4 identifies the allocation scope of caller allocations and calls.
- Source syntax and explicit I/O remain unchanged. Types, ownership, effects,
  resource identities, and representation evidence remain separate judgments.
- The graph is the sole production Runtime HIR, verified by conformance.

## Delivery ledger

- [x] Relevant refinement proof graphs and correct compiler-limit reporting.
- [x] Linear UTF-8 cursors, scalar traversal, and trimming.
- [x] Last-use borrow checking, including aliases and captured borrows.
- [x] Checked continuation graph, schema, validator, and Rust test interpreter.
- [x] Complete graph emission and removal of separate suspension planning.
- [x] Invocation allocation scopes, liveness releases, and shared-value
      retention.
- [x] ABI 4 compiler, hosts, workers, development links, and caller migration.
- [x] Consuming Spark jobs, prompt retirement, and bounded source parallel map.
- [x] Atomic selection across channels, subscriptions, and explicit-clock
      timers.
- [x] Constant-time queues and lifetime statistics.
- [x] Graph-unit persistence, callback links, and revision-aware invalidation.
- [x] Checked-summary preservation and useful proof/liveness/cache explanations.
- [x] Compiler, package, browser, and downstream execution acceptance.
- [x] Performance gates exercised; the wall-clock limitation is recorded below.

Each entry is marked only after exercising its real implementation. Keep
verification results here as units complete. Operational notes do not replace
the normative language, compiler, lifetime, cost, cache, or ABI contracts.

## Final verification

The final compiler artifact is
`cb299e997558df5b974205c13e31d2d0883cc7886af54a012b321711c45587da` (6,815,112
bytes): host ABI 7, checked-module certificate 20, Runtime HIR 13, and guest
ABI 4. The compiler, formatted prelude snapshot, and Node package have been
rebuilt together.

- Native Rust: 552/552 tests. Node: 265/265. Evaluator/Wasm conformance: 22/22.
- Web Workers: 2/2. Accepted compilation corpus: 216/216, with no refusals.
- All 79 regression files exercised. The full run found stale formatting in new
  examples and preludes; after correction, the formatter passed 36/36 and the
  remaining eight regression files passed separately.
- Real-Wasm allocator, canonical, frame, and managed-value proofs pass,
  including 100,000 child calls and allocating iterations with bounded pages and
  zero live payloads after completion. Guest ABI audit: 66 administrative calls.
- Development/cache: 19/19; callbacks/bridges: 22/22; active workload: 1/1. A
  provider edit emits one unit, disk restart restores graph bodies, callbacks
  preserve their provider revision, and retiring callbacks releases old units.
- Rust formatting/Clippy, Deno formatting/lint/type checks, generated artifacts,
  current implementation manifest, and package checks pass. New memory and ABI
  checks are CI requirements.
- In the downstream game, both requested commands were run. All 41 compiler
  probes execute successfully, including the five original failures. Full
  verification passes 43 tests, type checking, the production build, and all 31
  browser scenarios. Float equality remains outside these probes.

The hot-reload HTTP/SSE tests and actual Web Worker tests pass. No in-app
browser session was available for an additional interactive inspection of that
example; the downstream production browser scenarios did execute through its
test harness.

The deterministic compiler work gates pass, including zero semantic work for
unchanged input and leaf-only checking in the 500-module chain. The lowering
audit passes its documented ABI 4 budgets. The 5 MiB development timing gate
remains unverified under the machine's competing compiler workloads: the final
20-sample run measured 163.7 ms median / 267.0 ms p95, while an isolated
checkout of exact starting main measured 298.8 / 321.1 ms. Both exceed the
existing 100 ms target. These non-simultaneous runs do not establish a speedup
or a regression. The target is unchanged. Every edit transferred only its
provider; current activation p95 was 1.05 ms and maximum RSS growth was 2.80 MB.

## Required observations

UTF-8 traversal work grows linearly; unrelated declarations do not exhaust a
small proof; a live alias still prevents suspension. A waiting invocation must
not retain completed siblings' allocations. Bounded actors and parallel maps
must stabilize live bytes, frames, jobs, leases, and queues. Selection commits
one winner and leaves losing messages available. Cancellation drains admitted
operations before memory release. Cold/warm/restarted graph reuse preserves
fresh execution, generative identity, source origins, and owned state.

Final acceptance includes the full native, Node, Web Worker, regression,
conformance, accepted corpus, package, and performance suites. Rebuild the
compiler and prelude snapshot, then verify the downstream game's compiler probes
and browser scenarios. All original five probes must execute; logical negation
uses `not`, and float equality is outside the compiler-bug scope.

## Foundation checkpoint

The first rebuilt compiler artifact is
`5d8c8e58498d925123dda18b4e18a3f21fa2c082ac82ee3526f12b6e84012cd1` (6,520,802
bytes), with checked-module certificate 20. Focused native tests cover indexed
proof dependencies and genuine limit exhaustion, shared Text and bounded memo
keys, cursor primitive cost, and last-use ownership. Public tests cover 34
refinement cases, five borrow groups, and the existing seven suspension cases.
Text cursor tests exercise all UTF-8 widths, replay, malformed offsets, and
traversals above 131,072 scalars. The borrow program returns 42 in the source
evaluator and emitted Wasm with the expected request trace; the cursor catalog
example also agrees across both executions.

Cursors use the ordinary source tag `#TextCursor (Text, Int)`. EOF produces
`#None`; invalid byte offsets trap. Full dynamic seal typing is outside this
representation change. Evaluator Text shares immutable storage, and bounded
memo-key admission avoids hashing an entire large string at each cursor step.

## Graph cutover checkpoint

Runtime HIR schema 13 is now the sole production representation. The separate
suspension planner is deleted; the host reader, development linker, and Wasm
emitter consume explicit continuation parameters, captures, and call edges. All
525 native tests pass. All 22 conformance programs agree between evaluator and
emitted Wasm. The 40 backend tests include packed saved-state layouts, parallel
back-edge argument swaps, and complete emitted-module validation. Public tests
pass for suspension, 100,000 request iterations, effectful Unit tail recursion,
Spark lifetimes, bounded mapping, and large Unicode traversal. The
development/runtime/cache suites pass all 28 cases; 67 host boundary, snapshot,
pipeline, and product tests also pass.

The verified graph artifact is
`8944e80332c739a8c57cbd346d1d2ff63d354eecf3a41b4800493fa387e278ec` (6,566,837
bytes). A broader audit found stale block-count budgets after call splitting and
an engine instruction/byte budget discrepancy still requiring investigation. At
this checkpoint the budgets had not been raised, and allocation lifetimes, ABI
4, selection, and persistent graph reuse were still in progress.

## Allocation checkpoint

ABI 4 artifact
`d2908de5c9b4c891b6af8ceccbdfef21b479cbcde42a2b4233cb92888de5dcdb` passes all
534 native tests, all 22 evaluator/Wasm conformance programs, and 18 focused
source tests for ABI scopes, Spark, suspension, and UTF-8 cursors. The
actual-Wasm allocator, canonical adapter, frame, and managed-value scripts
exercise independent scopes, stale tokens, nested arrays, interior Text slices,
persistent and owned updates, duplicate arguments, and cancellation. Both
100,000 child calls and 100,000 allocating synchronous iterations reuse pages;
completed invocations retire all live allocation bytes. The later final
acceptance run rebuilt after the cache, callback, and selection fixes.

A clean isolated build of starting main `4c4ebaf` reproduces the engine audit's
existing budget discrepancy: 8,554 operations, 169 blocks in its largest
function, and 162,590 Wasm bytes exceed 2,300 / 88 / 62,000. The new graph has
8,022 instructions plus 532 call transitions, accounting for exactly the same
operations. ABI 4 adds allocator and canonical-adapter code, whose fixed cost
and reuse are measured separately. No source-instruction regression is hidden by
a budget increase.

## ABI 4 lowering budget comparison

The clean starting-main artifact is
`03cc6d2c1135de60789b4f2e7aa31175379aea2740dea685b03df19e934784a2`. The ABI 4
comparison artifact is
`6a976f391a12b0ec38c12ab181b9c1b6c9106b0596eeac4017a533bfe564088b`. These are
whole guest modules, including allocator, canonical adapters, and reference
functions. ABI 4 pays a code-size cost for independent invocation lifetimes and
shared immutable backing. The audit keeps calls in its operation count even
though they are now transitions. Each workload retains its previous operation
count. Continuations include new explicit call-successor nodes and therefore
have a different size from the former basic blocks.

| Workload                   | Operations | Old blocks / new continuations (largest function) | ABI 3 bytes | ABI 4 bytes |
| -------------------------- | ---------: | ------------------------------------------------: | ----------: | ----------: |
| `collect_principal_type`   |          1 |                                             1 / 1 |       1,786 |       7,074 |
| `text_processing_eval`     |         10 |                                             1 / 1 |       3,398 |      10,891 |
| `polymorphic_collections`  |         19 |                                             1 / 1 |       7,326 |      15,213 |
| `runtime_memory_lowerings` |        443 |                                           18 / 22 |      20,517 |      41,454 |
| `star_dijkstra`            |        488 |                                           30 / 34 |      12,113 |      31,991 |
| `owned_radix_sorts`        |        741 |                                           10 / 22 |      20,688 |      46,033 |
| `owned_merge_sort`         |        166 |                                           11 / 22 |       6,782 |      17,249 |
| `game_loop`                |      8,554 |                                         169 / 202 |     162,590 |     206,181 |

The audit now uses explicit ABI 4 size/local budgets with approximately ten
percent headroom, and continuation budgets that account for call successors. The
engine operation ceiling is corrected from its already-failing 2,300 to 8,600
around the unchanged measured 8,554 operations. Other operation ceilings remain
unchanged. This is a recorded representation-budget rebaseline, not a
performance claim. `pnpm test:memory` proves steady-state reuse, while the
compiler performance gate independently enforces zero semantic work for
unchanged input and leaf-only checking in the 500-module chain edit.
