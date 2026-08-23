# Predicate refinements

## Status

This document specifies the implemented unknown-first refinement contract.
[`LANGUAGE.md`](../LANGUAGE.md) is normative for the source surface.
[`TYPECHECKING.md`](TYPECHECKING.md) remains authoritative for the ordinary type
lattice, and [`SAFETY.md`](SAFETY.md) remains authoritative for relational
proofs over particular run-time values.

The contract makes most type declarations ordinary compile-time values or pure
predicates while retaining the existing representation, inference, effect,
ownership, layout, and compilation guarantees. The supported model is complete
at the canonicalization boundary defined below: open variables receive canonical
constraints, closed types admit composable source predicates, and
safety-sensitive relations require finite replayable evidence.

## 1. Thesis

Every unannotated value begins as a fresh inference variable. A lambda therefore
starts schematically as `'a -> 'b`, and its body and call sites accumulate lower
and upper constraints until the compiler has enough information to settle a
representation. `Int`, arrays, records, variants, arrows, and effect rows are
the canonical constraints that refine those unknowns; they are not eager nominal
classifications.

```blot
let identity = fn value => value
// identity : forall 'a. 'a -> 'a

let name_of = fn value => value.name
// name_of : forall 'field. { .name = 'field; } -> 'field

let count = fn values => Array.length values
// count : forall 'element. ['element] -> Int
```

Calling a quantified function freshens its variables, constrains the argument,
result, and effect row together, and settles only what the use requires. This is
the unknown-first core. Predicate-defined types participate by normalizing to
the same canonical constraints before they enter the graph.

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

The accepted inhabitant-predicate grammar is semantic rather than lexical:

```text
p ::= x relation k | k relation x | p junction p | negation p
```

`k` is a compile-time integer. Operators are accepted only when their
compile-time values satisfy the same factorisation proof used by branch
narrowing: `relation` is any function of two integers whose result factors
through `@int.cmp`, `junction` has the truth table of conjunction or
disjunction, and `negation` has the truth table of boolean complement. A
shadowed function called `>=` has no authority merely because of its spelling.

The predicate parameter must occur only as an operand of accepted comparisons.
Recursion, effects, run-time captures, arbitrary calls, and opaque observations
are rejected with `BLOT_REFINEMENT_PREDICATE`. Refusal is preferable to
sampling: testing a few inputs cannot prove a predicate over an unbounded
domain.

### 2.1 The primitive boundary is semantic, not an operator list

The compiler does not assign authority to `==`, `!=`, `<`, `&&`, or any other
source spelling. Integer comparison functions are ordinary source values. A
candidate is accepted only when the existing factorisation proof establishes
that it observes both operands exactly once through `@int.cmp`. The compiler
then records the subset of `{ less, equal, greater }` for which that value
answers true. All eight subsets are meaningful; there is no closed compiler
enumeration of source comparison operators.

Conjunction, disjunction, and negation are likewise ordinary source functions.
Their complete input domains are finite, so their boolean truth tables can be
established exactly. This is a primitive semantic basis, not a privileged
prelude vocabulary. Source may define and compose any names over it.

### 2.2 One requirement operation

The surface has one operation for applying a requirement:

```text
@satisfies : value -> (canonical type | closed-type predicate) -> value
```

This is a normalization boundary rather than a union injected into the type
lattice. The checker first evaluates the requirement. If `bridge(requirement)`
produces a canonical type, that type constrains the subject's still-open
inference variable. Otherwise the checker reifies the subject's settled type,
applies the requirement as a compile-time predicate, and accepts only `#True` or
`#False`. The assertion then erases.

A `sig` uses this same requirement classifier and subtype judgment. It accepts
only the canonical branch because an adjacent lambda may need bidirectional
rank-N checking; predicate requirements are observations and cannot elaborate a
lambda. Thus there is one semantic kernel with two source presentations, not two
assertion mechanisms.

That one rule covers scalar, collection, structural, higher-order, effect, and
nominal requirements:

```blot
// Scalar. Int is the canonical signed-integer domain constraint.
let increment = fn value =>
  let value = @satisfies value Int
  return value + 1

// Homogeneous collection. The carrier and element start open.
let accept_ints = fn values => @satisfies values [Int]

// Trait-like behavior is a record constraint plus width subtyping.
const Renderable = { .render = Unit -> Text; }
let render = fn value =>
  let renderable = @satisfies value Renderable
  return renderable.render ()

// Higher-order behavior includes the callback's effect row.
const Console = @effect { .write = Text -> Unit; }
const Command = Text -> Unit ~ { Console }
let install = fn callback => @satisfies callback Command

// Variants and nominal seals are the same kind of canonical requirement.
const Message = #Ready | #Failed Text
const UserId = seal ("UserId", Int)
let accept_message = fn value => @satisfies value Message
let accept_user = fn value => @satisfies value UserId
```

Requirements may be abstracted by a staged function:

```blot
const require = fn requirement => fn value => @satisfies value requirement
let checked = require { .name = Text; } { .name = "Ada"; .age = 36; }
```

The `const` is semantically important: specialization supplies the requirement
before checking the returned closure. An ordinary runtime parameter is rejected
with `BLOT_SIG_NOT_COMPTIME`; it is never trusted as an unchecked predicate.

A call freshens quantified variables, connects the argument, result, and effect
rows, and solves the accumulated constraints. Thus `identity` remains
`forall a. a -> a`, while calling `increment` makes its carrier integer and
calling `render` requires only the one method it uses.

Closed questions use the same operation with an ordinary source predicate:

```blot
const both = fn (left, right) => fn type => left type && right type
const is_shape = fn type => case reflect type of
  #Shape _ => True
  _ => False
const has_name = fn type => refines (type, { .name = Text; })
const named_shape = both (is_shape, has_name)

let person = { .name = "Ada"; .age = 36; }
let checked = @satisfies person named_shape
```

Predicates do not constrain open variables. That is deliberate: a predicate can
reject a closed type but cannot grant an operation or become an arbitrary
closure node in biunification. Use the canonical record, array, arrow, variant,
seal, or range value when the requirement must refine an unknown.

The minimal closed-type observations are:

```text
@type.reflect type             expose neutral outer structure
@type.equal left right         exact alpha-equivalent type-value identity
@type.instantiate forall arg   eliminate one outer binder with a chosen value
@type.probe forall             eliminate one binder with a kind-correct witness
```

`@type.reflect` reports an outer quantified type as `#Forall`, but never exposes
the binder's internal identity or an open body. Source inspects it by applying
`@type.instantiate` to a chosen type value. A kind-polymorphic traversal uses
`@type.probe`, which chooses `Unit` for an ordinary type binder and the empty
row for an effect-row binder.

```blot
const rec is_function = fn type => case reflect type of
  #Arrow _ => True
  #Forall => is_function (@type.probe type)
  _ => False

const Identity = @forall (fn T => T -> T)
let id = fn value => value
let checked_id = @satisfies id is_function
```

Exact equality remains primitive because reflection intentionally hides
quantifier identities, opaque type identities, and effect-row internals. Field
tests, function decomposition, recursive arrow traversal, conjunction, and
disjunction remain ordinary source.

### 2.3 Layout, facts, and ownership stay compositional

Layout members travel with canonical type values, so refining an attached
integer type keeps the namespace that selects its representation:

```blot
const SmallI32 = refine (I32, fn value => value >= -10 && value <= 10)
const bits = SmallI32.bit_width
```

Relationships between particular immutable values remain replayable evidence in
`Phi`, not type parameters. A body-verified summary can cross a function or
module boundary and authorize a later direct access:

```blot
let at = fn values => fn index =>
  if index >= 0 && index < Contracts.count values:
    return @array.get values index
  return 0
```

Ownership remains `Omega`. Applying a requirement is an identity: it neither
copies nor consumes the carrier, so an owned value still has exactly the same
affine obligations before and after refinement. These three domains compose at a
call site without being collapsed into one unsound lattice.

## 3. Elaboration and normalization

Closed unions have one normal form before they enter the solver: flatten nested
unions, remove `bottom`, let `top` absorb, remove duplicate members, and map
zero or one member to `bottom` or that member. Exact ground intersection and
difference return through the same normalizer. Open inference variables never
enter this Boolean layer; their joins remain Simple-sub lower bounds.

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
checking therefore receive the same canonical types they already understand. An
empty intersection is rejected with `BLOT_EMPTY_REFINEMENT`; Blot has no source
bottom type value.

Inhabitant-predicate inversion accepts integer bases. This is the complete
supported inversion boundary: the existing integer lattice has discrete
inclusive bounds and exact difference. Arrays, records, arrows, variants, effect
rows, and seals already constrain unknowns directly as canonical type values, so
they do not require closure inversion. Text has no successor operation, floats
contain NaN and do not have singleton types, and accepting an arbitrary closure
for either would turn subtyping into program equivalence.

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
identical Runtime HIR operations and equivalent WebAssembly. The benchmark
records:

1. cold and warm checking time for predicate and canonical-range spellings;
2. emitted Wasm byte length and SHA-256;
3. Runtime HIR operation counts; and
4. execution result and steady-state run time.

Recognition is linear in the predicate AST after comparison and boolean values
have been characterized by their finite semantic answer sets. Recognition is
cached by compile-time value identity. Normalization over the initial fragment
produces at most one additional range piece per distinct comparison boundary;
implementation limits must reject an oversized predicate before pathological
compile-time growth.

## 7. Deliberate rejection boundaries

The following are rejection boundaries of the supported language, not incomplete
implementations:

- no unchecked `assume`;
- no implicit run-time validation or coercion;
- no arbitrary closure nodes in biunification: structural, array, arrow,
  variant, seal, and effect requirements enter as existing canonical
  constraints, while source predicates inspect closed reifiable types;
- no dependent function arrows or general theorem proving;
- relational publication is the verified unary affine
  `length(parameter) + literal` certificate schema;
- no ownership facts inside the type lattice; and
- no change to Runtime HIR or the public ABI.

These boundaries keep checking decidable, evidence unforgeable, and the runtime
representation stable. Any different language feature would need its own
normalization, evidence, and erasure theorem; it is not an unfinished mode of
this contract.

## 8. Implemented behavior map

| Requirement            | Implemented mechanism                                       | Regression evidence                                           |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| Unknown carriers       | fresh Simple-sub variables and call-site freshening         | `inference.test.ts`                                           |
| Integer inhabitants    | exact predicate-to-range normalization                      | `predicate_refinements.blot`                                  |
| Arrays                 | homogeneous canonical constraints from operations and calls | `collections.blot`                                            |
| Trait-like behavior    | record width/depth subtyping and direct projections         | `type_predicates.blot`                                        |
| Higher-order functions | arrow intersections and shared row variables                | `inference.test.ts`                                           |
| Effects                | inferred open rows, handlers, and reflected closed rows     | `effects.blot`                                                |
| Layout                 | attached namespaces preserved by refinement                 | `layout_table.blot`, `predicate_refinements.blot`             |
| Fact passing           | verified affine summaries replayed across functions/modules | `relational_summaries.blot`, `refinement_types_on_crack.blot` |
| Ownership              | separate affine `Omega` analysis                            | `owned_region_capabilities.blot`                              |
| End-to-end composition | all layers in one checked and evaluated program             | `refinement_types_on_crack.blot`                              |

The integrated example imports a body-verified length wrapper, uses the
published summary to authorize a direct array read, propagates a callback effect
through a higher-order function, invokes a structural method, preserves an `I32`
layout namespace through scalar refinement, and consumes an affine value. Every
predicate and certificate erases before Runtime HIR.
