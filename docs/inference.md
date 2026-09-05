# Inference

Blot's Rust checker combines algebraic subtyping, compile-time evaluation,
checked predicate refinements, and a separate ownership analysis. Signatures are
optional in many programs, but they are not redundant: they constrain public
interfaces, express quantified requirements, and close runtime export
representations. The prelude itself uses signatures.

`LANGUAGE.md` is the normative language reference. The focused contracts in
`spec/` define compiler pass boundaries. This document explains the model; it
does not replace either contract.

## Algebraic subtyping and stable rebinding

The checker uses lower and upper bounds, levels for let-polymorphism, and
biunification. Literals may have singleton types; structural records admit width
subtyping; effect rows track which capabilities a computation uses. Ownership
and linearity remain separate from that lattice.

```blot
let identity = fn value => value
let answer = identity 42
```

A signature is an upper-bound requirement checked by subsumption, not an
instruction to silently widen an incompatible value. Explicit `@forall`
requirements are predicative: the checker does not infer an arbitrary
impredicative instantiation.

`:=` preserves an existing binding's stable type. Singleton integer and text
bindings widen to their domain at this boundary. Another `let` or `const` is the
explicit way to shadow a name while changing its type. Generated loop
accumulators retain bidirectional constraints while their recursive types are
still unsettled; an already closed signature remains a stable requirement.

Do not extend complexity or principality claims for the algebraic inference core
to arbitrary compile-time programs, refinement solvers, ownership analysis, or
the whole compilation pipeline. Those are separate obligations.

## Effects

A computation contributes its performed effects to an ambient row. A function
records the row of its body. An ordinary pure arrow has an empty row; an
explicit row is written after the arrow:

```blot
const Console = @effect { .write = Text -> Unit; }
let greet :: Text -> Unit ~ { Console }
let greet = fn name => do:
  use result <- Console.write name
  return result
```

Written row tails use `..e`. They relate repeated positions in a signature; an
isolated unconstrained tail must not erase an effect from the interface. See the
signature/effect-row section of `LANGUAGE.md` for the accepted quantification
rules. The older assertion that row tails cannot be written was stale.

`@handle` explicitly names the effect being discharged. Remaining effects still
belong to the surrounding computation. An unhandled top-level effect is rejected
unless it is part of the declared host boundary. Handler clauses must satisfy
the operation and continuation ownership contracts.

`use` sequences an effectful expression; merely placing an effectful call in an
ordinary `let` is not an implicit effect handler. Explicit continuation
cancellation is already available as `Continuation.cancel`; this review does not
introduce an asynchronous runtime or cancellation semantics.

## Types are values

Signatures and type-producing `const` expressions are evaluated and bridged into
the checker. There is no separate type namespace or type-expression parser.
Checking can execute compile-time code and is not an untrusted-code sandbox.

```blot
const Bit = 0 | 1
let bit :: Bit
let bit = 1
```

A computed structural field name must have compile-time text evidence.
`@shape.get value "field"` is checked as a field projection. An arbitrary
runtime key is not a license to give a heterogeneous record a homogeneous
indexing type. Dictionaries are a different abstraction.

## Operators and abstraction

The standard source fixities and ordinary prelude bindings select the operator
vocabulary. Generic numeric and comparison operations resolve an attached member
using the inferred operand domain. Nothing becomes available without the
appropriate import and `open`.

There is an important current limit: unresolved arithmetic/comparison operands
default to `Int` in the checker. Extracting an unconstrained equality helper
therefore does not imply a polymorphic equality requirement:

```blot
let same = fn left => fn right => left == right
```

Use an explicit operation argument when different interpretations are needed:

```blot
let same_with = fn equal => fn left => fn right => equal left right
```

This is an ordinary function, not a compiler-recognized dictionary form. The
coherence review also found a phase-sensitive raw-type attachment case; see
`experiments/language-review/README.md`. It is not fixed by these library
extensions and must not be presented as a guaranteed coherent overload model.

`&&` and `||` are short-circuiting prelude functions with deferred demand. The
named `Logic.and` and `Logic.or` operations retain that behavior. The old claim
that both arguments are necessarily evaluated was incorrect. Boolean logic
remains distinct from type-set `&` and `|`.

Operator precedence is defined by the actual source fixity header and its
checked generated table. `scripts/source_fixities.test.ts` and
`examples/operators.blot` are preferable to an independently maintained
precedence table that can silently drift.

## Refinement facts and proof loss

A recognized predicate contributes branch-local facts. Recognition must use
checked implementation evidence, not a function's name or an operator's
spelling. A shadowed comparison does not automatically establish ordinary
integer equality. Demand behavior matters for short-circuit certificates.

The current relational analysis can establish bounds for direct checks such as
`index >= 0 && index < @array.len values`. It does not generally export that
relationship through an arbitrary helper returning `Bool`. The
`predicate-helper-loses-bounds` claim records that limitation explicitly.

General range arithmetic and helper predicate summaries remain separate work. In
particular, `index < length` and `next = index + 1` imply `next <= length`, not
`next < length`. Retaining an affine relation cannot justify carrying an
obsolete strict bounds fact into another iteration. A loop requires an
appropriate invariant or a fresh check.

Coverage checks must remain fail-closed. An unknown target type is not
permission to leave an implicit no-match trap. Complements or branch-local facts
must not mutate globally shared inference bounds.

## Executable claims

`docs/language-claims.json` distinguishes accepted programs, intended
rejections, and current implementation limits. Its Node test executes accepted
programs as Wasm and checks the stated diagnostic for rejected programs. A
current limit is not a permanent language design promise: when it is
implemented, promote its claim and change its expected outcome.

`src/node/language_review.test.ts` additionally checks evaluator/Wasm agreement,
full-width decimal integers, floating-point edge cases, and pipeline adapters.
Full positive i64 decimal literals already work; the old signed-32-bit
source-literal restriction was stale. Separators, exponent notation, hexadecimal
notation, and unrestricted arbitrary-precision source arithmetic are not
implemented by this review's library additions.
