# Language and syntax review implementation

This change ships the bounded library and editor additions listed below. The
broader review remains a research roadmap, not a claim of completed compiler
features. `LANGUAGE.md` specifies the optional module contracts and their
restrictions; unfinished compiler work is separate from this library change.

## Implemented changes

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

## Working, restricted prototypes

- [x] Checked scalar field evidence and a nonempty integer-product encoder in
      `blot:derive`. Unsupported ownership shapes are refused. Deferred getters
      avoid a reproduced static-capture specialization bug; they do not fix it.
- [x] Baba-based expression markers and a bounded completion validator using the
      real Rust/Wasm checker. All markers must be replaced before checking. This
      is not native typed-hole inference, obligation display, or a sandbox.

## Deferred compiler and tooling roadmap

- [ ] Stable operator owner identity, coherent selection across phases/imports,
      and an explicit generic-operation defaulting contract.
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
- [x] Specify the optional module contracts in normative `LANGUAGE.md` and
      record their bounded implementation status in `SUGGESTION.md`.
- [ ] Complete broader cancellation/host-exit auditing and research evaluations.

The research acceptance criteria and two opt-in failing correctness probes live
in `experiments/language-review/README.md`. Known wrong output is not made into
a passing expected-output test.

## Validation

Local validation uses Node 22.16.0 and the actual Rust/Wasm compiler workspace
published for main commit `bbd33c00275189a45d22ad6c23cb231567d0d583`, with the
ordinary source modules and TypeScript changes in this PR. No Rust semantic
source, grammar, generated parser, or runtime ABI has been changed.

```sh
node --import tsx --test \
  src/node/language_review.test.ts \
  src/node/derivation.test.ts \
  src/node/language_claims.test.ts \
  src/tooling/control_flow.test.ts \
  experiments/language-review/completions.test.ts
```

Result: **52 passed, 0 failed**. The existing hover test plus the seven new
control-flow tests also pass with the repository's Deno-test compatibility
loader. A focused TypeScript check of the new production code and tests passed.
These are not claims that the full repository suite was run locally.

The first implementation commit's CI rebuilt the compiler, passed 402 Rust unit
tests, formal checks, Rust lint/formatting, performance gates, and TypeScript
checking, then failed at formatting. Its later integration steps did not run.
The current PR checks, not that earlier run, determine readiness.

The hover and canonical-formatting repairs in #91 passed the complete standard
Rust/Wasm CI in run 33975519182. The subsequent documentation and integration
changes are subject to their own unchanged CI checks. Neither result establishes
that the deferred compiler roadmap is implemented.

## Constraints retained

Baba remains the only lexer/parser. Rust/Wasm remains the semantic authority.
Ownership remains separate from the type lattice. The main prelude snapshot and
runtime ABI are unchanged. Reflection does not obtain authority from a field
name alone; unresolved completion markers never discharge obligations.
