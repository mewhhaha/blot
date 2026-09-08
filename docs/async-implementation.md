# Async implementation

The accepted design is portable suspension with explicit `use`, structured
tasks, CPU workers, scoped shared state, events, and cancellation before
development activation. Rust owns all semantic lowering and ownership facts.

Implementation order:

1. Checked suspension contracts, resumable Wasm, canonical host adapters, and
   cancellation cleanup.
2. Structured tasks and browser/Node worker execution.
3. Atomic values, partitioned numeric buffers, and mutex-protected records.
4. Scoped events, bounded channels, and development activation.
5. Inline annotations, `continue`, collection/Result APIs, numeric literals,
   and incomplete editor checking.

## Portable execution

After specialization, Rust computes the transitive closure of calls that may
suspend. Each affected function is partitioned at suspending operations and
calls. A resumable activation retains its live values and the next segment;
resumption does not repeat previously executed effects. Functions outside that
closure retain the direct calling convention. The host only fulfills typed
requests and schedules the next Wasm step.

This file records implementation sequencing. `LANGUAGE.md`, the focused
compiler specifications, and `docs/abi.md` own the normative contracts. A phase
is complete only after its real compiler/Wasm acceptance tests pass.

## Current implementation

The portable suspension portion is implemented: `Effect.suspends`, checked
borrow exclusion, Rust segment and frame emission, ABI 3 requests, canonical
scalar/Text/record/compatible-variant adapters, `callAsync`, abort signals, and
asynchronous `close`. Unaffected functions retain direct calls. The suspension
closure is computed with a reverse call graph worklist.

`pnpm test:async` is the focused acceptance gate. It executes the emitted Wasm
and checks effect order, recursive activations, branching, canonical values,
cancellation races, stale requests, reentrant resumption, host failures, and
allocation reclamation. It also asserts target refusal for unsupported layouts,
owned host cancellation, and development suspension. `pnpm conformance` compares
the source-handler evaluator result with the same computation run through real
Promise-backed Wasm host operations.

Phase 1 remains incomplete: source resource finalizers, canonical array copying,
and heterogeneous dynamic variant payloads still need implementation. Frames
currently retain all SSA slots and child allocations until invocation release;
liveness-based slot allocation, frame reuse, and CPU cancellation checkpoints
remain outstanding. One invocation can be active per instance.

Phases 2–5 are not implemented by this change. In particular, there are no Task,
worker-transfer, shared-memory, channel, scoped-event, or async hot-reload APIs
yet. Development compilation refuses suspending units before publishing a
candidate. Complete checked cleanup before removing that gate, then implement
task scopes and scoped events against the same cancellation protocol.

## Validation

The compiler and package were rebuilt. The current changes pass 472 native Rust
tests, 177 Node tests (including 11 suspension probes), evaluator/Wasm
conformance, package checks, generated-contract checks, and focused type checks.

The downstream game's `test:compiler` and full `verify` passed in an isolated
copy configured to load this worktree's package: all 40 compiler probes are
supported, including the five original numeric/control-flow failures, and all
24 browser scenarios passed. The tested compiler SHA-256 is
`742a476557aece3ef1b4f81262fad5b4164d87310d12413b67132c5e9fa27118`.

The general regression suites were exercised in batches. The existing
`scripts/node_regression_tests.test.ts` synchronous-stall timeout test fails
under the installed Node 24.12.0, including in the main checkout. That unrelated
test remains unchanged; the other suites pass after updating the new example
to the repository formatter's output.
