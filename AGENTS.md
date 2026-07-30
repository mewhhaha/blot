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

**Nothing is implicitly in scope.** The prelude is an ordinary module reached
through `@import` and spread with `open`; it gets no seeding, no privileged
scope, and no exemption from its own type system. A default fixity names a
binding by string, so `+` works only because something opened `Num` — do not
reintroduce an implicit scope to make that line disappear.

**A loop is a fold, not an assignment.** `for` and `loop` desugar during CST
lowering: the names their bodies rebind with `:=` become the accumulator
record, and nothing downstream of the parser knows a loop exists. `break`
becomes a locally handled abort carrying that record. Do not give these forms
AST nodes, typing rules, or backend paths — each would be a second way to say
what recursion and handlers already say. And do not add assignment to make a
loop read more directly; that would put mutation in a language whose ownership
analysis assumes there is none.

**`:=` preserves type.** It shadows an existing binding with another value of
the same stable type; singleton literals widen to their integer or text domain
when rebound. A repeated `let` or `const` is the explicit way to shadow a name
while changing its type.

**Surface forms desugar; they do not get machinery.** `for` and `loop` become
`rec`/`case` recursion, `break` becomes a locally handled abort, and `x <- e`
becomes `let x = e ()`, all during CST lowering, so nothing downstream of the
parser knows these forms exist. A desugaring emits the recursion rather than
calling a prelude function that contains it: a keyword whose meaning depends
on a name being in scope is a dependency the program cannot see. A new form
earns an AST node only when no existing one can say what it means — otherwise
it is a second way to say something the language already says, and every pass
has to learn it.

**Types are values.** There is no type-level sublanguage and no type namespace.
If a feature seems to need one, it belongs in the comptime evaluator instead.
This is what keeps the grammar small; do not reintroduce `type`, `interface`,
`effect`, or `duck` as declaration forms.

**`@handle` names its effect.** The checker must see that call site — the
effect being discharged is part of the typing rule — so `@handle` is the one
primitive that takes a tuple rather than being curried, and it has no prelude
wrapper. A wrapper would hide it behind a closure whose parameter is not a
compile-time value.

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

**Inference feeds the backend.** Field sets, constructor sets, and compile-time
declaration values are recorded during checking, keyed by AST node identity,
because a nominal declaration needs the whole set and a residual block may
still contain a local compile-time binding. Do not re-derive them in the
backend — that is a second type checker and, for effects, would mint a different
identity. This is why `load` keeps one cache per process.

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
