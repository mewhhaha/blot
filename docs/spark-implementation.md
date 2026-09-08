# Spark implementation

This is the implementation ledger for the accepted explicit-context concurrency
design. Unchecked entries describe proposed behavior, not supported language
APIs. `LANGUAGE.md` and the compiler specifications remain the normative
contracts.

The host supplies an executor and selected services as opaque capabilities in an
ordinary `io` record. A scope selects its executor once. Child scopes, jobs,
channels, subscriptions, and cleanup inherit that lifetime. There is no implicit
current-I/O context, detached task, public mutex, or shared object graph.

## 1. Portable suspension and ownership

The follow-up to PR #118 adds lexical borrow exclusion for direct and transitive
suspension, including unannotated callbacks with open effect rows. A separate
Rust suspension plan now supplies the framed call graph and segment boundaries
to development partitioning and emission. `pnpm test:suspension` runs the
focused ownership, cancellation, allocation, callback, and development checks.

- [x] Source `Effect.suspends` descriptor and checked suspension contracts.
- [x] Rust-emitted resumable frames, including calls, recursion, and handlers.
      Loop state, nested calls, source-handler agreement, independent
      outstanding calls, and UTF-8 memory growth pass
      `src/node/suspension.test.ts`.
- [x] ABI 3 start/resume/cancel and canonical aggregate host values. Records,
      arrays, and variants pass the real Wasm suspension path. Owned affine
      values cross this path. Linear host transfers remain refused until their
      registered ownership protocol is supported.
- [x] Explicit runtime capabilities with identity and generation validation.
      `Resource.of`, opaque host leases, ancestor scope checks, and never-reused
      token identities pass `src/node/resources.test.ts`. `Resource.of_type`
      adds invariant type arguments, preserved through specialization and
      validated against host leases.
- [x] Scope-owned resources, reverse-order cleanup, cancellation masking, and
      cancellation/completion race handling. Host resources have reverse async
      cleanup, drained acquisitions, and cancellation race tests.
      `Spark.on_exit` consumes a precompiled guest callback. Real Wasm tests
      cover normal exit, module shutdown with masked cleanup, retained ancestor
      leases, and traps that reclaim host resources while skipping guest
      finalizers. Mixed guest/host cleanup order and aggregated failures are
      checked in the host resource tests.
- [x] Evaluator/Wasm agreement and real Promise-based host integration tests.

## 2. Structured concurrency, channels, and reload

The source-first implementation uses ordinary host effect signatures for
scheduling and channels. Checked callback entries are emitted with the artifact;
starting a job never compiles code. `src/node/callbacks.test.ts` checks affine
one-shot callbacks, capture lifetime, nested suspension, evaluator/Wasm
agreement, pure CPU cancellation, and constant frame memory over 50,000 tail
calls. Generic host-operation specialization now lets one source operation serve
distinct checked payload types, with evaluator/source-handler/Wasm agreement in
`src/node/suspension.test.ts`.

- [x] Source `Spark.scope`, `child_scope`, `spawn`, `join`, `cancel`, and
      `yield`. Real Wasm tests cover at-most-once admission, concurrent work,
      cancellation/drain, sibling failure, child scopes, explicit cancellation,
      yield, and implicit joins on scope return.
- [x] Bounded channels, rendezvous, ownership transfer, and close/cancel
      wakeups. FIFO delivery passes at capacities 0, 1, 2, and 16. Close rejects
      new sends, drains buffered messages, and is idempotent. Tests cancel both
      blocked senders and receivers through actual Wasm calls. Affine arrays
      cross the channel and attempted source reuse is rejected. Resource
      messages retain the existing lease ownership checks.
- [x] HTTP, clock, and event adapters with explicit subscription policy. Real
      Wasm tests cover local HTTP responses, origin refusal, selected clocks,
      timer cancellation, latest delivery, FIFO delivery, overflow failure, and
      subscription cancellation with late events ignored.
- [x] Cancel and drain affected scopes before hot reload; preserve unaffected
      scopes and services, reject stale completions, and retain old artifacts
      for their cleanup. The hosted development runtime now drains affected
      calls, runs cleanup against the old provider map, retains the unchanged
      consumer instance, rejects late results, and activates the new provider.
      Its real Wasm test passes. Worker callbacks pin precompiled dependency
      bundles; nineteen revisions reuse one worker and bound its program cache.
      Scoped suspending links preserve caller resources, concurrent-call
      cancellation, provider cleanup, and cooperative CPU checkpoints across
      worker units. Callback values themselves still cannot cross a link;
      compiled callbacks remain in their owning unit.
- [x] Browser example with async events and task-owned state.
      `pnpm example:spark-browser` serves the event actor, explicit I/O, and
      cleanup controls. Its HTTP/Wasm contract test passes. Interactive browser
      verification remains unavailable in this session.

## 3. Parallel and speculative work

- [x] `Spark.parallel` with precompiled worker entries and reusable worker
      pools. Node integration passes worker/module reuse, cancellation/drain,
      purity rejection, and fresh private heaps after a trap. Submission
      transfers a `WebAssembly.Module` once per worker and invokes its checked
      callback entries with canonical captures. The Web Worker transport test
      passes in Deno; there is no connected interactive browser in the current
      session.
- [x] `Spark.speculate` for pure work with affine deferred demand, buffered
      failures, at-most-once execution, and cancellation of unused work. Three
      Node worker tests cover skipped work, deferred promotion, buffered traps
      before/after demand, and required progress beside unused CPU work.
- [x] `Spark.map_parallel`, cooperative checkpoints, and progress guarantees.
      Source mapping preserves order and skips empty input. Pure CPU jobs yield
      and cancel. Speculation reserves required worker capacity. A scalar fold
      completes 100,000 suspensions with constant Wasm memory after warm-up.
- [x] Explicit shared numeric partitions and atomics; isolated private heaps,
      exact-cover joins, browser isolation setup, and crash invalidation.
      `blot:shared` uses ordinary source effects and host numeric leases. Eight
      Node cases cover disjoint writes, atomic progress, both float precisions,
      nested joins, stale/duplicate/overlapping access, malformed descriptors,
      queued and admitted cancellation, trap invalidation before cleanup, and
      pure/speculative refusal. The same shared example passes Web Workers in
      Deno. The i32 storage API validates source Int values at its boundary.
- [x] Browser/Node worker tests and rerunnable iteration-time measurements. The
      HTTP example test prints initial-build, provider-edit, and resource-edit
      timings. Node workers exercise development reload and bounded program
      eviction; the Web Worker transport is tested in Deno. Interactive browser
      verification remains unavailable.

## 4. Language ergonomics

- [x] Inline typed bindings and `use` bindings. These elaborate to
      signature/binding pairs. `inline_signatures.blot` observes evaluator/Wasm
      agreement for typed const, rec, affine let, direct sequencing, and forced
      nullary sequencing. The Baba general profile is accepted without parser
      resolutions.
- [x] `continue` through ordinary loop control desugaring. Nested loops, guard
      exits, preserved accumulators, invalid targets, frontend parity, and
      dynamic Wasm calls pass.
- [x] Data-last collection APIs and effectful owned iterator traversal. Existing
      `blot:pipeline` adapters cover borrowed arrays; `Iter.fold_with` and
      `Iter.each` sequence effects over owned iterator state.
- [x] Result/Option composition and lazy defaults. Callable type constructors
      carry source namespaces; both pure and suspending callbacks pass. Deferred
      defaults skip trap-producing expressions and are demanded at most once.
- [x] Baba numeric separators, exponent floats, and hexadecimal integers. The
      version-3 general parser profile remains accepted without resolutions.
- [x] Native editor holes with checked context and refusal to emit unresolved
      holes. `_` in expressions reports Rust-inferred expected and local types;
      filling the hole clears its diagnostic and permits emission.

Each implementation slice updates its normative specifications and includes
observable regression tests. Final acceptance includes compiler, parser profile,
Node, examples, conformance, package checks, and the game integration probes
with zero unsupported results. Pure synchronous exports retain direct execution.

The follow-up verifies all 480 native compiler tests, 225 Node tests, the two
native Web Worker tests, all 215 accepted examples without refusals, 21
evaluator/Wasm conformance cases, and six package checks. `pnpm test:suspension`
contains 24 focused checks, including direct/transitive/open-row borrow refusal,
late cancellation, and allocation retention until the last caller leaves. The
regression runner now enforces deadlines from its parent process and its four
harness checks pass. All 77 regression files pass, including the
synchronous-timeout fixture.

`pnpm test:web-workers` runs the native Web Worker transport in Deno; the Node
compatibility runner intentionally excludes that platform-specific file.

A reload measurement observed 124 ms for initial compilation, 23 ms for a
formula edit, and 0.15 ms for a text-resource edit. These are local observations
from the rerunnable HTTP test, not latency guarantees. Resource edits invoke no
compiler and worker submissions reuse precompiled modules.

The compiler artifact for this follow-up is
`03cc6d2c1135de60789b4f2e7aa31175379aea2740dea685b03df19e934784a2` (6,461,463
bytes, host ABI 7, checked-module certificate 19, guest ABI 3).

Resumable frames reuse canonical request/result slots and tail frames. The
shared bump arena still retains variable-length payload allocations and non-tail
frames while another invocation remains live; general long-lived actors need
further lifetime work. Linear host transfers and callback values crossing
development-unit links remain refused as documented above. Interactive browser
verification of the new event-actor page was unavailable; its HTTP/Wasm path and
the native Web Worker transport are tested separately.
