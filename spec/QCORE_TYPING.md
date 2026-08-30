# Pure QCore typing and conversion shadow

## Authority and boundary

This document defines the executable judgment implemented by
`compiler/src/qcore_typing.rs`:

```text
validate(M) = ValidatedQModule(M)
check-pure(M) = CheckedPureQModule(M)
```

`check-pure` accepts only the output of structural validation. A successful
result proves that each local definition inhabits its declared boundary under
the rules below. It remains a shadow artifact. Checking Blot source, preparing
Runtime HIR, evaluating, emitting Wasm, and caching compiler results do not
consume it.

The error type is an invariant failure for an internal QCore artifact. It is not
a source diagnostic. An unsupported constructor is named in the error rather
than assigned a guessed rule.

## Admitted terms

The pure value fragment contains:

```text
x | global | Prop | Type(i)
Pi (x : A) [grade] . B | Sigma (x : A) . B
lambda x . c | (v, w) | fst v | snd v
```

The pure computation fragment contains:

```text
return v | let v in c | bind c in d | v w
```

Every function and computation boundary must carry the canonical empty effect
row. Local value definitions may be referenced through their exact definition
and semantic keys. A local computation has no value type and cannot appear as a
`GlobalDefinition`. An imported definition cannot appear because QCore version 3
records no imported type boundary.

The following forms stop at `UnsupportedPureFeature`:

- effect-row variables and extensions, `Perform`, and `Handle`;
- `Thunk` and `Force`;
- proof witnesses;
- effect-row and interval-grade values;
- all version-3 structural certificate terms; and
- a `Bind` whose result type depends on the bound computation result.

This is an exact boundary. In particular, a `StructuralFunction` is not treated
as a dependent function and a structural effect set is not treated as an effect
row.

## Bidirectional typing

Contexts use nearest-binder-first de Bruijn indices. If the type stored for
context entry `i` was formed before its intervening binders, lookup weakens that
type by `i + 1`. Crossing `Pi`, `Sigma`, `Lambda`, `LetValue`, or `Bind` raises
the cutoff by one. Substitution shifts its replacement beneath intervening
binders and lowers indices above the removed binder. Index overflow is an
invariant failure.

Universes follow these rules:

```text
Prop    : Type(0)
Type(i) : Type(i + 1)
```

`Type(u32::MAX)` is rejected because its successor has no schema representation.
A `Pi` whose codomain has sort `Prop` has sort `Prop`. Otherwise its sort is the
maximum level of its domain and codomain. Every `Sigma` has
`Type(max(domain-level, codomain-level))`; `Prop` contributes level zero to that
maximum. `Pi` into `Prop` is impredicative: the domain sort does not raise its
`Prop` codomain.

The shadow kernel has exact universe conversion, not cumulative universe
subtyping. Thus a value inferred at `Type(0)` does not check against `Type(1)`.
This restriction is not a claim about the eventual Blot source type system. A
later QCore design must add an explicit cumulative checking judgment before
QCore can become authoritative.

`Prop` has no proof eliminator in the admitted grammar. Proof witnesses,
inductive values, imports, effects, and structural constructors are outside the
boundary, and local globals are checked by the same rules. No `Prop` elimination
or erasure policy is exercised. The kernel does not prove proof irrelevance or
authorize erasure. Any future proof eliminator must state its `Prop`-to-`Type`
elimination policy before entering this fragment.

Typing is bidirectional where the schema omits annotations. A lambda checks
against a `Pi`; it does not synthesize a standalone type. A pair checks against
a `Sigma`, and can also synthesize the nondependent `Sigma` formed from its two
inferred component types. Direct application of a lambda infers the parameter
type from the argument, checks the body in the extended context, and substitutes
the argument into the result type. This direct form computes the body's
syntactic use count and assigns the unexposed binder its exact grade `[n, n]`;
the count must fit the schema's `u32` finite bound.

For a checked pair `(v, w) : Sigma (x : A) . B`, the second component checks at
`B[v/x]`. `fst p` has type `A`; `snd p` has type `B[fst p/x]`. `LetValue`
substitutes its known value into the body result type. The admitted `Bind` rule
requires its body result to be a weakening of a type from the outer context.

## Quantitative binder check

For `lambda x . c` checked against `Pi (x : A) [l, u] . B`, the kernel counts
free occurrences of `x` in `c`, adjusting the target index beneath every nested
binder. Addition saturates at `u32::MAX + 1`, which is enough to distinguish all
finite schema bounds from overflow. The count must satisfy:

```text
l <= uses
uses <= u, when u is finite
```

This is only the admitted pure fragment's syntactic multiplicity check for
capture-avoiding substitution. It is not a dynamic execution bound and does not
replace Blot's ownership analysis. The grade interval itself remains part of
definitional equality for `Pi` types.

## Conversion and termination

Conversion attempts full normalization within the artifact budget, keeps globals
opaque, and compares the resulting de Bruijn terms without source-node identity.
It includes these equations and their congruence closure:

```text
(lambda x . c) v  = c[v/x]
let v in c         = c[v/x]
bind (return v) c  = c[v/x]
fst (v, w)         = v
snd (v, w)         = w
```

Local globals may be recursive. Keeping them opaque makes conversion terminate
independently of that recursion, but does not make recursive proof definitions
logically total. A future proof-authority or erasure fragment must either
exclude unrestricted recursion at proof types or give it an explicit guarded or
partial interpretation.

Every beta or projection contraction consumes one unit from a reduction budget
of 1,000,000. Exhaustion returns `NormalizationLimitExceeded`; it never becomes
`false` conversion. A structurally valid but untyped omega regression exercises
that boundary. A module receives `CheckedPureQModule` only after all conversions
needed by typing finish within the bound. The limit is an artifact policy, not a
source-language reduction semantics.

The reduction budget does not bound recursive traversal depth or the size of an
intermediate produced by substitution. The normalizer memoizes arena-backed term
nodes, but a sufficiently deep artifact can still exhaust the Rust stack and
beta substitution can expand before the next contraction consumes fuel. The
executable kernel therefore does not yet claim machine-level totality for
arbitrarily large in-memory artifacts. A non-recursive traversal and a combined
allocation/depth budget are required before authority cutover.

## Formal mirror and open obligations

`formal/lean/Blot/QCoreTyping.lean` mirrors the admitted syntax, de Bruijn shift
and substitution, occurrence grades, compatible conversion, and mutually defined
value/computation typing judgments. It states direct witnesses for application
beta, both pair projections, top-variable substitution, and exact grade
containment. This is a declarative mirror. No theorem equates it with the Rust
algorithm.

The Lean file does not yet prove weakening, substitution preservation, subject
reduction, normalization, decidability, logical consistency, or adequacy of the
Rust executable checker. The Rust regressions exercise weakening and
capture-avoiding substitution directly. These missing theorems, the unsupported
forms above, cumulative universes, serialization, erasure, and a verified
translation to Runtime HIR must be closed before an authority cutover.
