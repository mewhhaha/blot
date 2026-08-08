# Remaining work

The implemented language is now substantially aligned with the model. Recursive
representations have checked SCC evidence, ownership certificates publish
complete extraction lineage, tight recursive loops become structured Runtime
HIR, and the Rust compiler admits the full executable example corpus. The work
below is what remains; capacity-bearing Stores and new surface features are not
part of this list.

## 1. Answer every CLI command from the production compiler

`check`, `build`, and `package` route through the Rust compiler; `eval` and
`ownership` still run the TypeScript oracle. Two engines answering one CLI is
how a checker disagreement stays invisible: a program can be accepted by
`blot check` and rejected by `blot eval` without any gate noticing, because the
two commands never meet.

`RustMiddle` already exposes `evaluateCompilerSessionModule`, and
`experiment:compiler-eval-parity` already drives it, so `eval` is mostly a
matter of surfacing it on `Compiler` and matching the printed value format the
example corpus asserts. `ownership` needs the Rust ownership facts exported from
the session first.

Until both move, `spec/COMPILER.md` records the exception and the usage text
names which engine answered.

Fold `experiment:compiler-eval-parity`'s skip list in while doing it: it skips
every module with a module parameter or an unhandled effect, so the two
evaluators are never compared on a program that performs a host effect — the
class where `spec/COMPILER.md` says operation order is the observable semantics.

## 2. Recover the lower bound a nested `rec` fold loses

`iterate` and `collect` infer `⊥` and `[⊥]` for values they demonstrably
produce:

```blot
open @import "blot:prelude" ()
return iterate (Iter.range (1, 4), 1, fn (product, n) => product * n)
```

`blot check` says `⊥`; `blot eval` says `6`. `collect (Iter.range (0, 4))`
likewise types as `[⊥]` and evaluates to `[0, 1, 2, 3]`. `⊥` is the printed form
of a positive variable with no lower bound, so the base case's type is not
reaching the result.

It is not recursion by itself. The same fold written at module scope keeps its
bound:

```blot
let go =
  rec (fn (n, carried) => case n == 0 of
    #True => carried
    #False => go (n - 1, carried + n)
  )
return go (3, 0)          -- Int
```

What differs is that the prelude's `go` is a `rec` inside a function, closing
over that function's parameters, with the accumulator flowing through a `visit`
callback. Find which of those three loses the edge before changing the lattice —
a union that prints one member per bound will make the answer visible now that
the printer no longer repeats them.

Because `⊥` describes a value that cannot exist, an inferred `⊥` for a value
that does is worth more than a presentation fix: anything that consumes these
types — reflection, specialization keys, the ABI boundary — is reading a claim
the program contradicts.

## 3. Construct Runtime HIR progressively

Checking and Runtime-HIR preparation still traverse overlapping semantic work.
Fuse them without moving ownership into the type lattice:

1. Give each settled residual expression a stable typed-HIR builder state.
2. Commit a final Runtime-HIR node as soon as its type, effects, representation,
   ownership permission, and safety evidence are closed.
3. Keep unresolved structural folds and specialization choices pending; they are
   not final nodes and must not acquire a fallback representation.
4. Replace formatted-type specialization keys with structural identities from
   the settled graph.
5. Consume compact ownership and safety evidence while constructing the node,
   then independently validate the completed graph.

Do not reuse a `ClosedProgram` across a source edit merely because runtime
behavior appears unchanged: source origins are observable compiler output, and
an earlier edit can shift every later span. Revision reuse must preserve exact
origin identity or rebuild the affected suffix.

Measure unchanged preparation, semantic edits, checking, Runtime-HIR
construction, emission, and peak memory independently. The change is complete
only when the artifact and all parity gates are unchanged and the measured
preparation/checking boundary improves; moving work behind a different timer is
not an optimization. Update the pass and cache contracts in `spec/COMPILER.md`,
`spec/TYPECHECKING.md`, `spec/STAGING.md`, and `spec/COST_MODEL.md`.

## 4. Move the bounded oracle onto typed Core

The production Rust/Wasm compiler is already independent of gpupaper, but the
bounded TypeScript/gpupaper conformance oracle still shares part of the source
schedule. Make typed Core its input so the oracle compares a real pass boundary:

1. Lower Core values and computations, including `define`, `bind`, handlers,
   control results, and ownership/proof markers, without consulting surface
   scheduling again.
2. Keep gpupaper bounded and independent. It must not become a compiler fallback
   or a production dependency.
3. Retain the current source-AST evaluator only as an independent observation
   model, not as input to Core lowering.

Generated source/Core evaluations, handler traces, host traces, and the complete
bounded oracle corpus must continue to agree. Update `spec/COMPILER.md`,
`spec/CORRECTNESS.md`, and the effect-sequencing row in `spec/PAPER.md`.

## 5. Mechanize the stable core

Once residual closures stop changing the core representation, mechanize the
smallest useful preservation/progress result. Include live pure bindings,
functions and finite closure choices, variants and exhaustive cases, effects and
one-shot handlers, checked signed-integer traps, structural ownership, and
proved array operations. Omit modules, parsing, reflection, SIMD, source
desugarings, and the public ABI from the first artifact.

Prove or encode:

- type preservation and classified progress, including divergence and specified
  traps;
- phase erasure for compile-time-only values;
- no double move, affine at-most-once use, and linear exact use on terminating
  exits;
- bounds safety for proved array operations; and
- simulation from validated Runtime HIR operations to the small target model.

Keep executable generation and mutation tests. The mechanization supplements
those bounded simulations; it does not replace the Rust/TypeScript parity,
artifact reproducibility, ABI, or emitted-Wasm gates.

## Handoff checks

Before each push, run:

```sh
just check
just test
```

For compiler-artifact changes, also rebuild the checked-in Rust compiler and
prelude snapshot, verify reproducibility, run the complete Rust compiler
integration suite, and confirm `verify:rust-compiler` still admits all
executable examples. Keep `LANGUAGE.md` synchronized with source semantics and
the focused compiler specifications synchronized with every pass, certificate,
cache, or Runtime-HIR contract change.
