# Persistent staged types and selective instantiation

## Scope

The semantic authority remains the Rust compiler. This change replaces the
ownership and instantiation machinery for first-class type values, not the
language's algebraic subtype solver. No source feature is deliberately removed:
structural records, singleton/range types, unions, higher-order functions,
quantification, first-class type constructors, generative effects, and separate
ownership checking remain available.

## Why comptime dominates

The earlier [`T2_ATTRIBUTION.md`](../cold-semantic/T2_ATTRIBUTION.md) measured
83.4% of the full-minus-prefix slowdown in evaluator work during semantic
preparation. That is a historical **incremental cost**, not the percentage of
every compilation attributable to comptime.

At the starting revision, `8d30e17cfabcb341d5617be59ce46a12672dc603`, the
source-prelude native driver observes 4,481,654 evaluator steps and 363,094
closure applications for the full fixture. These counts include preparing the
prelude from source; the normal snapshot-prelude path is measured separately.
The fixture builds and validates abstractions by executing ordinary Blot code.
The additional schedule/world combinations cause many more such executions. The
existing call cache correctly refuses functions, generative identities and
unsettled polymorphic signatures; a faster subtype solver alone cannot remove
that evaluator work.

There is also avoidable work _inside_ each execution. Before this change,
function/range type edges were recursively owned boxes. Signature substitution
reconstructed already-closed type structure. Binding a closed array signature
could reflect and union the entire actual argument array even though there was
no type variable to bind.

## New boundary

- `compiler/src/type_value.rs` owns persistent function/range type edges. Clones
  share immutable nodes; mutation detaches the node and invalidates its summary.
  Summaries distinguish variables, effect identities, and union normalization.
  Quantifier binders remain explicit and independently owned.
- `compiler/src/type_instantiation.rs` owns call-boundary signature substitution
  and binding. Closed fields do not reconstruct argument types. Open fields
  still collect the required evidence, including every element of a
  heterogeneous generic array. Closed edges inside otherwise open signatures are
  shared.
- The solver, semantic value equality, module/effect identities, call-result
  cache admission, source grammar, portable certificates and public ABI do not
  change. Shared addresses are never evidence of semantic equality. No result
  from one substitution environment is cached for another environment.

A closed union may still need flattening, duplicate removal or singleton
collapse. Its dependency summary therefore prevents the substitution fast path
from accidentally bypassing normalization. An effect with no type variables
likewise still requires environment-specific identity substitution.

## Reproduction

Build the baseline and candidate with the repository's pinned Rust toolchain,
using the same release profile and flags. Keep each resulting Wasm file before
building the other revision. No compiler binary belongs in the commit.

```sh
cargo build --locked --release --manifest-path compiler/Cargo.toml \
  --target wasm32-unknown-unknown
node experiments/compiler-bench/staged-types/compare.mjs \
  --baseline=/absolute/path/baseline.wasm \
  --candidate=/absolute/path/candidate.wasm --samples=5 > comparison.jsonl
```

The driver uses only Node built-ins and the compiler ABI. Each sample starts a
fresh Node process, creates a fresh Wasm instance/session, installs the same
tracked prelude snapshot, loads the same local fixture sources and runs traced
semantic analysis including target preflight. Artifact order alternates. It
records artifact/input hashes, Node/CPU provenance, type/effect/interface
results, all phase telemetry and guest memory size. Wasm creation and
source/snapshot preparation are measured separately from analysis. No warmup
samples are removed. Use `--prelude=source` to measure source-prelude
preparation instead; do not mix those samples with snapshot-prelude samples.

This is a semantic-analysis benchmark, not an end-to-end CLI startup or emitted
program execution benchmark. Telemetry counters are not interchangeable with
wall-clock time, and native debug timings are not production speed claims.

## Correctness and cost gates

```sh
cargo fmt --manifest-path compiler/Cargo.toml -- --check
cargo test --locked --manifest-path compiler/Cargo.toml
cargo clippy --locked --manifest-path compiler/Cargo.toml \
  --target wasm32-unknown-unknown -- -D warnings
```

The focused tests require zero value-reflection visits for a closed
10,000-element array argument, one visit for the unsettled field of a mixed
record, independent substitutions across calls, correct effect substitution and
union normalization, copy-on-write isolation, quantifier shadowing and
stack-bounded summary traversal. They gate deterministic work/semantics rather
than unstable timing thresholds.

## Rejected experiment

A broader comptime memoizer was tested before the graph redesign. Allowing
immutable type values and higher-order input identities did not help while
admission still excluded polymorphic calls. Moving admission after instantiation
and adding conservative evidence keys reduced the native fixture's evaluator
steps by about 2%, but increased debug wall time. That experiment is not
shipped. In particular, this change does not share closure results or fresh
effects merely because a call appears pure.

## Demand-driven evaluator follow-up

The evaluator no longer resolves and substitutes every expression's type merely
for an optional representation-recording callback. Concrete expressions demand
that evidence only for numeric literals, arrays and cases; application result
contexts and closure signatures keep their independent semantic demands. A
representation callback is installed only when a residual trace and checked type
are both present. This is an interpreter/type-evidence boundary change, not a
new subtype relation or broader closure memoization policy.

The comparison driver accepts `--telemetry=on` (default) and `--telemetry=off`.
Run both modes to distinguish a production-path improvement from measurement
overhead. Output schema 2 records `telemetryMode`; telemetry-off samples omit
the optional `telemetry` field. All samples remain fresh-process analyses, not
full CLI or executable-emission timings. The driver now checks cross-artifact
input digests, principal types, effects, interface keys and target-preflight
results before accepting each subsequent sample for a fixture.

```sh
node experiments/compiler-bench/staged-types/compare.mjs \
  --baseline=/path/pr170.wasm --candidate=/path/demand-driven.wasm \
  --samples=5 --telemetry=off
node experiments/compiler-bench/staged-types/compare.mjs \
  --baseline=/path/pr170.wasm --candidate=/path/demand-driven.wasm \
  --samples=5 --telemetry=on
```

Regression coverage distinguishes genuinely needed numeric and residual type
facts from unused concrete-expression facts. Immediate diagnostic origins and
spans, deterministic expression fuel, and concrete leaves without an added
trampoline step are asserted directly; the ordinary compiler suites remain the
semantic authority.

The telemetry `eval.steps` counter counts trampoline drive-loop transitions, not
source-expression evaluations. Removing administrative callbacks lowers that
counter without reducing the number of source-level closure calls. Report both
counters and wall time; a transition reduction is not evidence that a source
algorithm has become asymptotically cheaper. Expression fuel is charged inside
`evaluate_expression` independently of those transitions.

Measured follow-up results and reproduction details are in `DEMAND_RESULTS.md`.
The complete fresh-process samples are retained in `demand-off.jsonl` and
`demand-on.jsonl`. Those results compare this increment with PR #170; they do
not replace the earlier comparison against `main` recorded in `RESULTS.md`.
