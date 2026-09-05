# Language and syntax review implementation

This PR unifies the operator-dispatch compiler work with the language-review
library and tooling work. It implements a bounded subset of the review while
preserving explicit acceptance criteria for follow-up work. A test or design
sketch is not an implemented compiler feature; the unified CI result is the
readiness authority for this branch.

## Implemented changes

- [x] Source-defined operator dispatch preserves attached member signatures,
      carries qualified member requirements through inference and serialized
      compiler boundaries, and uses `Op.negate` for prefix negation. Contextual
      numeric literals remain supported; already-bound Int, F64, and F32 values
      are not implicitly converted between domains.
- [x] Non-trapping F32/F64 partial comparison and explicitly named trapping
      aliases in the optional `blot:float` module.
- [x] Pure, configuration-first, data-last pipeline adapters in `blot:pipeline`.
- [x] Return/break destination hovers and accumulator hovers using Baba CST and
      the accumulator produced by existing lowering.
- [x] Executable documentation claims distinguishing accepted behavior, intended
      rejection, and current limits; explicit filtering and cancellation cases.
- [x] Regression coverage for already-supported full-width positive i64 decimal
      literals, evaluator/Wasm agreement, and explicit operation dictionaries.
- [x] Correct stale explanatory claims in `docs/inference.md`; document module
      contracts and limitations in `docs/language-review-extensions.md`.
- [x] Structural QCore carries qualified requirements, including generated Rust,
      TypeScript, and Lean representations plus formal scope validation.

## Working, restricted prototypes

- [x] Checked scalar field evidence and a nonempty integer-product encoder in
      `blot:derive`. Unsupported ownership shapes are refused. Deferred getters
      avoid a reproduced static-capture specialization bug; they do not fix it.
- [x] Baba-based expression markers and a bounded completion validator using the
      real Rust/Wasm checker. All markers must be replaced before checking. This
      is not native typed-hole inference, obligation display, or a sandbox.

## Remaining implementation

- [ ] Complete broader operator-coherence evaluation across constant/runtime
      phases and imported generic uses, including the opt-in correctness probe
      retained under `experiments/language-review`.
- [ ] Fix static-capture-sensitive residual function sharing before generalizing
      derivation to unrestricted runtime getter closures.
- [ ] Checked predicate summaries surviving abstraction, proof-loss diagnostics,
      and overflow-safe affine relations with loop-invariant acceptance tests.
- [ ] Baba-only numeric separators, exponent notation, and radix literals;
      regenerate/profile the frontend and test lexical boundaries.
- [ ] General ownership-aware reflection with consuming extraction, rebuilding,
      remainder obligations, sum derivation, and private construction authority.
- [ ] Native expression holes carrying type, effect, phase, ownership, and
      refinement obligations while refusing incomplete production artifacts.
- [ ] LSP document highlights for control-flow targets and effect-polymorphic
      variants of the pipeline adapters.
- [ ] Complete normative documentation integration and broader
      cancellation/host-exit auditing and research evaluations.

The research acceptance criteria and two opt-in failing correctness probes live
in `experiments/language-review/README.md`. Known wrong output is not made into
a passing expected-output test.

## Validation

Earlier focused validation covered the language-review modules and tooling, and
an earlier operator-dispatch revision exercised focused compiler tests. Those
results are historical evidence only. This unified branch changes Rust semantic
code, QCore representations, generated protocol artifacts, the prelude, optional
library modules, and editor tooling together, so only CI on the actual unified
head establishes merge readiness.

The unified CI must rebuild the Rust/Wasm compiler and pass formal Lean checks,
Rust formatting/lint/tests, generated-artifact checks, TypeScript checks, Node
and regression suites, runtime verification, target compatibility checks, and
performance gates before merge.

## Constraints retained

Baba remains the only lexer/parser. Rust/Wasm remains the semantic authority.
Ownership remains separate from the type lattice. Reflection does not obtain
authority from a field name alone; unresolved completion markers never discharge
obligations. Qualified member requirements must not be erased merely to select a
runtime representation.
