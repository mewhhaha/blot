# Integer refinement normalization costs

This is the representation-cost contract for the integer normalization in
`compiler/src/predicate_refinement.rs`. The accepted predicates and their
inhabitant sets remain those of [Predicate refinements](PREDICATE_REFINEMENTS.md).
There is no new type rule, language syntax, primitive, certificate, or ABI.

## Canonical interval invariant

An interval sequence passed to intersection contains inhabited, sorted,
non-overlapping, non-adjacent integer intervals. A missing lower endpoint means
negative infinity; a missing upper endpoint means positive infinity. Arithmetic
on endpoints uses arbitrary-precision integers. Runtime-domain clipping occurs
against the inclusive signed-64-bit bounds, not by overflowing an endpoint.

Base collection normalizes once after traversing its value graph. Comparison,
disjunction, and complement return canonical sequences. Intersection preserves
canonical order and gaps without another sort.

## Diagnostic ownership

An empty refinement points at the predicate body in the predicate closure's
module. Unsupported predicate expressions retain their precise expression span
and explicitly identify that same module. Calling through the ordinary prelude
`refine` wrapper must not relocate those spans to the prelude. Diagnostic codes
and rejection stages are unchanged.

## Required work bounds

For canonical inputs with `m` and `n` intervals, intersection advances at least
one input cursor per comparison. It performs at most `m + n - 1` comparisons when
both inputs are nonempty and emits at most that many intervals. Endpoint integer
operations have their usual bit-width-dependent costs; the claim is about the
number of interval operations, not constant-time arbitrary-precision arithmetic.

Base collection uses an explicit work stack and deduplicates borrowed value
identities within one call. For a graph of `V` distinct values and `E` edges, graph
traversal takes expected `O(V + E)` hash-table work. Collecting `K` leaf intervals
then performs one `O(K log K)` normalization. The traversal must not recursively
expand shared union diamonds or repeatedly sort nested union prefixes.

Pointer identities are local visitation keys only. They do not survive the call,
enter persisted artifacts, replace semantic equality, or permit invalid leaf
kinds. Traversal preserves left-to-right error discovery.

## Regression evidence

`compiler/src/predicate_refinement_tests.rs` compares the sweep with a Cartesian
oracle over bounded and unbounded interval sets, checks canonical output and
commutativity, tests signed-64-bit endpoints, and counts sweep iterations for
8,192 interleaved intervals on each side. A shared union diamond of depth 30
checks that base collection follows graph sharing rather than its expanded tree.

`src/compiler/refinement_pathologies.test.ts` checks 24 executable examples by
exact principal type, golden evaluator value, and emitted Wasm observation. Eight
negative examples must parse before producing their specified checking diagnostic
with a nonempty source span. These tests are not wall-clock performance claims.
