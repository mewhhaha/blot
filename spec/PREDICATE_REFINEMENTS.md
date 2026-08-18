# Predicate refinements

## Status

This document specifies the first experimental slice of predicate-defined types.
[`LANGUAGE.md`](../LANGUAGE.md) is normative for the implemented surface.
[`TYPECHECKING.md`](TYPECHECKING.md) remains authoritative for the ordinary type
lattice, and [`SAFETY.md`](SAFETY.md) remains authoritative for relational
proofs over particular run-time values.

The experiment asks whether Blot can make most type declarations read as pure
predicates while retaining the existing representation, inference, ownership,
and compilation guarantees. It deliberately does not replace those mechanisms.

## 1. Thesis

A source type may be introduced by a pure predicate:

```blot
const Natural = refine (Int, fn value => value >= 0)
const Byte = refine (Int, fn value => value >= 0 && value <= 255)
const NonZero = refine (Int, fn value => value != 0)
```

Functions remain ordinary arrows:

```text
A -> B -> C
```

and control flow remains ordinary source code. A branch adds facts about the
value it tested; it does not change the meaning of arrows or add an imperative
assignment operation.

The essential separation is:

```text
Gamma    structural and scalar representation types
Phi      duplicable propositions about immutable value identities
Omega    affine and linear ownership facts
```

`Gamma` answers how a value is represented and which operations are defined.
`Phi` answers facts such as `0 <= i < length(xs)`. `Omega` answers whether an
owned value may still be consumed. Classical propositions in `Phi` may be
duplicated; ownership evidence in `Omega` may not. Merging them would either
make proofs spuriously affine or make ownership spuriously duplicable.

## 2. Source operation

The prelude operation is:

```blot
refine : (Type, Predicate) -> Type
```

where `Predicate` is an ordinary pure compile-time function. Its implementation
uses the compiler primitive `@type.refine`; the primitive is necessary because
an unbounded integer domain cannot be enumerated in Blot source.

The initial accepted predicate grammar is semantic rather than lexical:

```text
p ::= x op k | k op x | p and p | p or p | not p
op ::= < | <= | == | != | >= | >
```

`k` is a compile-time integer. Operators are accepted only when their
compile-time values satisfy the same factorisation proof used by branch
narrowing. A shadowed function called `>=` has no authority merely because of
its spelling. Boolean junctions and negation are recognized by truth table, not
by name.

The predicate parameter must occur only as an operand of accepted comparisons.
Recursion, effects, run-time captures, arbitrary calls, and opaque observations
are rejected with `BLOT_REFINEMENT_PREDICATE`. Refusal is preferable to sampling:
testing a few inputs cannot prove a predicate over an unbounded domain.

## 3. Elaboration and normalization

Write `R(p)` for the exact integer set denoted by an accepted predicate. The
normalizer is defined by:

```text
R(x op k)   = integers whose ordering to k makes op true
R(p and q)  = R(p) intersect R(q)
R(p or q)   = R(p) union R(q)
R(not p)    = Int difference R(p)
```

Then predicate refinement is compile-time evaluation:

```text
Delta |- base downarrow T
Delta, x |- p normalizes R
T intersect R = U       U is inhabited
------------------------------------------------ refine
Delta |- refine(base, fn x => p) downarrow U
```

`U` is an existing range or finite ground union value. No predicate node enters
the biunification graph. Existing subtyping, coverage, reflection, and signature
checking therefore receive the same canonical types they already understand.
An empty intersection is rejected with `BLOT_EMPTY_REFINEMENT`; Blot has no
source bottom type value.

The first slice accepts integer bases only. This is a principled boundary: the
existing integer lattice has discrete inclusive bounds and exact difference.
Text has no successor operation, floats contain NaN and do not have singleton
types, and structural predicates need a separate row/shape proposition design.

## 4. Flow-sensitive facts

Predicate-defined types do not replace branch refinement. Given:

```blot
sig consume = Natural -> Int
let consume = fn value => value

sig checked = Int -> Int
let checked = fn value =>
  if value >= 0:
    return consume value
  return 0
```

the declaration of `Natural` normalizes to an existing range. The `if` branch
uses the existing comparison proof to narrow `value` to that range, so the call
is admitted without a cast or run-time validation. The else branch receives the
representable complement.

Predicates over relationships such as `i < length(xs)` remain propositions in
`Phi`; they do not become array type parameters. This preserves stable array
representations and keeps biunification polynomial.

## 5. Effects and ownership

A type predicate is evaluated at compile time with no host authority. The
accepted fragment contains no effectful expression. Consequently a predicate
cannot perform an effect, inspect a run-time value, or introduce a run-time
failure path.

Ownership is checked after ordinary typing and relational proof construction.
Refining an owned value does not copy, borrow, consume, or return it. The
refinement is a fact about the value, not another carrier. `Omega` therefore
continues to govern every use exactly once where required.

## 6. Erasure and performance obligations

Predicate normalization finishes before Runtime HIR. The erasure theorem is:

```text
normalize(T, p) = U
layout(T) = layout(U)
erase(e checked with U) = erase(e checked with the equivalent canonical range)
```

For integer refinements, both layouts are signed `i64`. A program that differs
only by spelling a canonical range as an equivalent predicate must produce
identical Runtime HIR operations and equivalent WebAssembly. The experiment's
benchmark records:

1. cold and warm checking time for predicate and canonical-range spellings;
2. emitted Wasm byte length and SHA-256;
3. Runtime HIR operation counts; and
4. execution result and steady-state run time.

Recognition is linear in the predicate AST after operator values have been
recognized. Operator recognition is cached by compile-time value identity.
Normalization over the initial fragment produces at most one additional range
piece per distinct comparison boundary; implementation limits must reject an
oversized predicate before pathological compile-time growth.

## 7. Non-goals of the first slice

- no unchecked `assume`;
- no implicit run-time validation or coercion;
- no structural, text, float, or effect predicates as types;
- no dependent function arrows;
- no ownership facts inside the type lattice; and
- no change to Runtime HIR or the public ABI.

Future work may generalize the normalizer to decidable structural predicates or
allow an explicit total run-time validator returning `Option Refined`. Either
extension must preserve the separation of `Gamma`, `Phi`, and `Omega` and must
state its erasure and representation theorem before implementation.
