# AGENTS.md

## Goal

The simplest language that keeps the reference feature set and fits baba's
WebGPU frontend profile.

```txt
source -> baba GPU frontend -> CST -> fixity fold -> AST
       -> comptime evaluation -> biunification -> linearity/ownership
       -> specialize -> gpufuck Functional Surface -> Wasm
```

blot owns source elaboration, inference, comptime, and ownership. baba owns
lexing and parsing; do not hand-write a lexer or parser. gpufuck owns Core-to-
Wasm emission; do not add a second backend.

## Invariants

These are the decisions a change must not silently reverse.

**The GPU profile is a gate, not an aspiration.** `deno task generate` must
succeed with `"throughput": "strict"` and the profile accepted. If a grammar
change needs a `metadata.parser.resolutions` entry to generate, the grammar is
wrong — every conflict so far had a design fix that made the language better,
not a metadata override. Record counter changes in `docs/gpu-profile.md`.

**Byte parity is the safety net.** The GPU frontend has no CPU fallback and no
partial program on failure. `just parity` must hold across the whole corpus
before a grammar change lands.

**Types are values.** There is no type-level sublanguage and no type namespace.
If a feature seems to need one, it belongs in the comptime evaluator instead.
This is what keeps the grammar small; do not reintroduce `type`, `interface`,
`effect`, or `duck` as declaration forms.

**Few primitives.** New capability goes in `src/prelude/*.blot` first. It earns
an `@`-primitive only when it cannot be written in blot at all. `struct`,
`packed`, `Bool`, `Option`, `fold`, and every operator are prelude source.

**Linearity is not in the type lattice.** Biunification stays polynomial only
if ownership and linearity remain a separate flow analysis over Core.

**Monomorphize before gpufuck.** gpufuck re-runs Hindley-Milner on what blot
emits. blot's algebraic-subtyping result is the authority; anything that
reaches gpufuck must be specialized enough for HM to re-check. A gpufuck
inference failure on a well-typed blot program is a lowering bug, never a
type-system disagreement to paper over.

**The three executions agree.** The comptime evaluator, gpufuck's GPU
evaluator, and the emitted Wasm run the same language. `just wasm` requires all
three to produce the same value; a lowering that satisfies one and not another
is wrong.

**Inference feeds the backend.** Field sets and constructor sets are recorded
during checking, keyed by AST node identity, because a nominal declaration
needs the whole set and the syntax does not carry it. Do not re-derive them in
the backend — that is a second type checker. This is why `load` keeps one cache
per process.

**`blot check` must not touch WebGPU.** Parsing has baba's `CpuFrontend`
oracle and inference is plain TypeScript. Keep the split structural so the
formatter and language server never initialize a device.

## Style

- No ternary expressions and no nullish coalescing.
- Do not silently default when compiler information is missing.
- Distinguish invariants from diagnostics. An invariant is a fact the compiler
  must already know — throw. A diagnostic is a problem with the user's program
  — accumulate and return, so a pass reports everything it found.
- A check that cannot infer a type stays silent rather than cascading one root
  cause into every derived expression.
- Inline a helper that only calls one other function.

## Tests

Deno tests next to the implementation they cover. `examples/` is the executable
catalog: one program per feature, including the ones that must be rejected and
the ones that must trap. Inference tests assert principal types as strings, so
a lattice change that widens an inferred type shows up as a diff rather than as
"still compiles".
