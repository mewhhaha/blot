# Predicate refinements

## Status and scope

This document specifies the implemented unknown-first refinement contract.
[`LANGUAGE.md`](../LANGUAGE.md), subject to [`COHERENCE.md`](COHERENCE.md), owns
the source surface. [`TYPECHECKING.md`](TYPECHECKING.md) owns the ordinary type
lattice, and [`SAFETY.md`](SAFETY.md) owns propositions about particular
immutable run-time values.

Predicate refinements normalize compile-time descriptions into the existing
canonical type algebra. They do not add arbitrary predicates to open
biunification, dependent arrows, unchecked assumptions, or new run-time
representations.

## 1. Unknown-first inference

An unannotated value begins with fresh inference variables. Uses accumulate
lower and upper bounds until checking has enough information to settle a
canonical type and representation.

```blot
let identity = fn value => value
// forall 'a. 'a -> 'a

let name_of = fn value => value.name
// forall 'field. { .name = 'field; } -> 'field

let count = fn values => Array.length values
// forall 'element. ['element] -> Int
```

Calling a quantified function freshens its variables and constrains argument,
result, and effect row together. Predicate-defined types participate only after
normalizing to canonical constraints already understood by ordinary inference.

The fact domains remain separate:

```text
Gamma  ordinary structural and scalar types
Phi    duplicable propositions about immutable value identities
Omega  affine and linear ownership state
```

`Gamma` determines operations and representation. `Phi` records facts such as
`0 <= i < length(xs)`. `Omega` controls consuming use. A proposition is not made
affine, and ownership evidence is not made duplicable, by refinement syntax.

## 2. Integer inhabitant predicates

The prelude operation is:

```blot
refine : (Type, Predicate) -> Type
```

Its implementation crosses the checked primitive `@type.refine`. The first
supported inversion boundary is the discrete signed-integer lattice.

An accepted inhabitant predicate is semantically equivalent to:

```text
p ::= x relation k
    | k relation x
    | conjunction(p,p)
    | disjunction(p,p)
    | negation(p)
```

where `k` is a compile-time integer.

Authority comes from behavior, not spelling:

- a relation value must factor through `@int.cmp`, observe each operand exactly
  once, and return true for an exact subset of `{less,equal,greater}`;
- a conjunction or disjunction value must have the corresponding complete
  boolean truth table; and
- a negation value must have the boolean-complement truth table.

A shadowed function named `>=`, `&&`, or `not` has no authority merely because
of its name. Conversely, a source-defined value with the admitted finite
semantics may be used.

The predicate parameter may occur only through the accepted comparison basis.
Recursion, effects, run-time captures, arbitrary calls, and opaque observations
are rejected with `BLOT_REFINEMENT_PREDICATE`. Sampling is never used to justify
a predicate over an unbounded domain.

Examples:

```blot
const Natural = refine (Int, fn value => value >= 0)
const Byte = refine (Int, fn value => value >= 0 && value <= 255)
const NonZero = refine (Int, fn value => value != 0)
```

## 3. Normalization

Write `R(p)` for the exact integer set denoted by an accepted predicate:

```text
R(x op k)  = integers whose ordering to k makes op true
R(p and q) = R(p) intersect R(q)
R(p or q)  = R(p) union R(q)
R(not p)   = Int difference R(p)
```

Refinement evaluates at compile time:

```text
Delta |- base downarrow T
Delta, x |- p normalizes R
normalize(T intersect R) = U
U is inhabited
----------------------------------------------
Delta |- refine(base, fn x => p) downarrow U
```

`U` is an existing integer range or finite ground union. No predicate closure
node enters the open inference graph.

Closed unions have one normal form:

- flatten nested unions;
- remove `bottom`;
- let `top` absorb;
- remove equivalent members;
- normalize zero members to `bottom`; and
- normalize one member to that member.

Exact closed intersection and difference return through the same normalizer. An
empty inhabitant refinement is rejected with `BLOT_EMPTY_REFINEMENT`; Blot
exposes no ordinary source bottom-type value.

The supported inversion boundary is deliberately narrow. Arrays, records,
arrows, variants, effect rows, and seals already constrain unknowns directly as
canonical type values. Text lacks the discrete successor structure required by
this normalizer, and floats contain NaN and have no current singleton-type
algebra. Accepting arbitrary closures would turn subtyping into program
equivalence.

## 4. Requirement application

The surface has one requirement operation:

```text
@satisfies : value -> (canonical type | closed-type predicate) -> value
```

The checker evaluates the requirement at compile time.

### 4.1 Canonical requirement

If the bridge produces a canonical type, that type constrains the subject's
ordinary inference variable through the declarative subtype relation.

```blot
let increment = fn value => do:
  let value = @satisfies value Int
  return value + 1

let accept_ints = fn values => @satisfies values [Int]

const Renderable = { .render = Unit -> Text; }
let render = fn value => do:
  let renderable = @satisfies value Renderable
  return renderable.render ()
```

Higher-order requirements include effect rows:

```blot
const Console = @effect { .write = Text -> Unit; }
const Command = Text -> Unit ~ { Console }
let install = fn callback => @satisfies callback Command
```

Variants and seals use the same canonical branch:

```blot
const Message = #Ready | #Failed Text
const UserId = seal ("UserId", Int)
let accept_message = fn value => @satisfies value Message
let accept_user = fn value => @satisfies value UserId
```

### 4.2 Closed-type predicate

If the requirement is not a canonical type, the subject type must already be
closed. The checker reifies that type, evaluates the requirement as a pure
compile-time predicate, and accepts only `#True` or `#False`.

A source record reconstruction may inspect a generic patch through a predicate
before its computed-field loop is specialized. Internal `bottom` placeholders do
not count as a closed subject there: the checker marks that closure for
specialization and evaluates the predicate exactly once the concrete call closes
both record types. No predicate constraint enters biunification.

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

A closed-type predicate may reject a settled type. It cannot grant an operation
on an open variable or become an opaque solver node. Use a canonical record,
array, arrow, variant, seal, range, or effect-row value when a requirement must
constrain an unknown.

### 4.3 Signatures

A signature header uses the same canonical requirement classifier and subtype
relation. It accepts only the canonical branch because an adjacent lambda may
require bidirectional rank-N checking; an arbitrary observational predicate
cannot elaborate an open lambda.

Requirements may be abstracted only when staging supplies them before checking
the returned closure:

```blot
const require = fn requirement => fn value => @satisfies value requirement
let checked = require { .name = Text; } { .name = "Ada"; .age = 36; }
```

An ordinary run-time requirement parameter is rejected with
`BLOT_REQUIREMENT_NOT_COMPTIME`; it is never trusted as an unchecked predicate.

## 5. Type reflection basis

Closed-type predicates use a deliberately limited observation basis:

```text
@type.reflect type             expose neutral outer structure
@type.equal left right         exact alpha-equivalent type identity
@type.instantiate forall arg   eliminate one outer binder
@type.probe forall             eliminate one binder with a kind-correct witness
```

`@type.reflect` reports an outer quantified value as `#Forall` without exposing
the binder's internal identity or an open body. Source traverses it by
instantiation or probing.

```blot
const rec is_function = fn type => case reflect type of
  #Arrow _ => True
  #Forall => is_function (@type.probe type)
  _ => False
```

Exact equality remains primitive because reflection intentionally hides
quantifier identities, opaque identities, and effect-row internals. Field tests,
function decomposition, recursion over closed reflected structure, conjunction,
and disjunction remain ordinary source code.

## 6. Flow-sensitive facts

Predicate-defined canonical types do not replace branch refinement. For example:

```blot
let consume :: Natural -> Int
let consume = fn value => value

let checked :: Int -> Int
let checked = fn value => do:
  if value >= 0:
    return consume value
  return 0
```

`Natural` normalizes to a canonical integer range. The accepted comparison adds
a branch fact that narrows `value` to that range. The else branch receives the
representable complement.

Relationships between particular values remain in `Phi`:

```blot
let at = fn values => fn index => do:
  if index >= 0 && index < Contracts.count values:
    return @array.get values index
  return 0
```

Here the direct read is authorized by a replayable identity-sensitive
proposition about `index` and this exact `values`, not by turning array length
into an ordinary type parameter.

## 7. Layout, effects, and ownership

A canonical type retains its attached layout namespace through integer
refinement:

```blot
const SmallI32 = refine (I32, fn value => value >= -10 && value <= 10)
const bits = SmallI32.bit_width
```

The inhabitant predicate and closed-type predicate fragments are pure
compile-time code. They cannot perform source or host effects, inspect run-time
values, or add a run-time failure branch.

Applying a requirement is an identity on the carrier. It does not copy, borrow,
move, cancel, or consume the value. `Omega` before and after the assertion is
the same, subject to ordinary demand: if the assertion occurs only in a dead
pure declaration, the whole declaration is absent.

An owned-value example must use an explicit statement block:

```blot
let checked = fn value => do:
  if value >= 0:
    return consume value
  return 0
```

The refinement fact does not duplicate the owned carrier.

## 8. Erasure and representation

Predicate normalization completes before Runtime HIR. For an integer refinement:

```text
normalize(T,p) = U
layout(T) = layout(U)
erase(check using U) = erase(check using the equivalent canonical range)
```

The predicate closure and `@satisfies` assertion erase. Equivalent predicate and
canonical-range spellings must produce equivalent Runtime HIR and WebAssembly.
No new public ABI type, tag, or run-time proof object is introduced.

Recognition is linear in the predicate AST after comparison and boolean values
have been characterized by finite semantic answer sets. Recognition is cached by
compile-time value identity. The implementation imposes deterministic expansion
limits and returns a `LimitDiagnostic`, not a source theorem, when such a bound
is reached before normalization completes.

## 9. Deliberate rejection boundaries

The supported contract rejects:

- unchecked `assume`;
- implicit run-time validation or coercion;
- arbitrary predicate closures in open biunification;
- dependent function arrows and general theorem proving;
- ownership facts inside the ordinary type lattice;
- run-time or effectful type predicates;
- predicate sampling as proof;
- hidden Runtime-HIR or ABI representations for predicates; and
- relationship publication outside the separately specified replayable summary
  schemas.

A future broader predicate language requires its own normalization,
decidability, evidence, and erasure theorem. It is not an unfinished mode of
this one.

## 10. Obligations and regressions

The implementation owes:

1. fresh unknown-first inference and call-site instantiation;
2. semantic rather than spelling-based predicate recognition;
3. exact integer-set normalization;
4. rejection of empty and unsupported refinements;
5. one `@satisfies` kernel for canonical and closed-predicate requirements;
6. no observational predicate constraint on an open variable;
7. branch narrowing through ordinary `Phi` facts;
8. unchanged ownership state across a requirement assertion;
9. complete erasure before Runtime HIR; and
10. representation equivalence between predicate and canonical spellings.

Regression programs cover scalar ranges, arrays, structural requirements,
higher-order effect rows, seals, reflection through quantified types,
relationship summaries, owned carriers, and end-to-end Runtime-HIR/Wasm
equivalence. The tests are evidence for these boundaries, not another type
lattice.
