# Blot: A Small Staged Language with Effects, Relationships, and Ownership

## Status of this document

This is a design paper for the language Blot intends to become. It is not the
current language reference. [`LANGUAGE.md`](../LANGUAGE.md) specifies the
implementation as it exists; this document specifies a coherent semantic model
against which that implementation can be audited and changed.

[`COMPILER.md`](COMPILER.md) turns the compilation boundaries used here into
pass contracts and a whole-compiler theorem obligation.

The distinction is intentional. An implemented behavior is not made sound by
describing it here. When the implementation and this model disagree, the
disagreement is an engineering item, not a reason to weaken the model silently.
Section 16 records the disagreements already known.

This document uses “sound” in several related but distinct senses:

1. accepted source has one parse and one elaboration;
2. compile-time evaluation cannot smuggle a run-time dependency across phases;
3. well-typed programs do not become stuck on an unclassified internal state;
4. effect rows account for every operation that can escape a computation;
5. exhaustive matches do not fail at run time;
6. ownership checking prevents duplication, loss, and escape of tracked
   resources;
7. proof-required memory operations cannot be out of bounds;
8. staging and specialization preserve source behavior; and
9. the reference evaluator, independent conformance evaluator, and emitted
   WebAssembly refine one source semantics.

It does not mean that every program terminates, that arithmetic never traps, or
that malicious host input is accepted. Divergence and specified traps are
behaviors. A compiler optimization must preserve them according to the demand
semantics below.

## Abstract

Blot is a small, expression-oriented functional language designed around five
constraints that are usually considered separately:

- its concrete grammar must be accepted by a massively parallel GPU parser;
- types and effect declarations are ordinary compile-time values rather than a
  second source language;
- principal inference uses algebraic subtyping;
- effects are explicit computations with lexically scoped handlers; and
- immutable source values may be implemented with destructive updates only after
  a separate ownership proof.

The proposed foundation is a two-phase, fine-grain call-by-value calculus with
liveness-erased pure bindings. Surface expressions elaborate into a small core
that distinguishes values from computations. `let` introduces a shareable pure
definition and does not itself establish evaluation order. `x <- c` is the
sequencing operation for a computation `c`; it does not insert an application
and it is not an alternative spelling of `let`.

The ordinary type lattice contains structural records, variants, homogeneous
arrays, ordered ranges, functions, effect rows, unions, intersections, and
predicative polymorphism. Relationships between run-time values are kept in a
separate refinement context. Thus an array has type `[A]`, while a local fact
may state `0 <= i < length(a)`. Direct indexing consumes that proof and can
lower without a bounds check; total indexing returns an `Option` and performs a
check. Ownership is likewise a separate judgment over the typed core rather than
another axis of subtyping.

The resulting compiler has proof obligations at each boundary: parsing,
elaboration, compile-time evaluation, inference, refinement, ownership,
specialization, Core lowering, and the WebAssembly ABI. The purpose of the model
is not to claim those proofs already exist. It is to make precise what each pass
would have to establish before the next pass may trust it.

## 1. Design thesis

Blot's central idea is not merely “a functional language parsed on the GPU.” It
is that a small number of semantic distinctions can do most of the work:

- source grammar is concrete and bounded, while elaboration carries the
  abstraction burden;
- values are not computations;
- compile-time availability is not run-time typing;
- structural type compatibility is not physical representation identity;
- value relationships are not ordinary types;
- ownership is not subtyping; and
- an external ABI is not an exposure of the compiler's heap.

These distinctions allow the surface language to remain small. Surface forms
such as `for`, statement `if`, element syntax, `try`, and early `return` should
elaborate to a core whose semantics does not mention them. Conversely, a feature
that survives into every later pass is not a surface convenience; it is part of
the core and needs typing and operational rules.

The language has the following non-goals:

- no ambient filesystem, clock, terminal, network, or random authority;
- no implicit prelude or privileged name resolution;
- no assignment in the source semantics;
- no second parser or backend;
- no dependent type checker inside algebraic subtyping;
- no promise to infer arbitrary relational invariants; and
- no acceptance followed by a representational refusal for an ordinary
  well-typed program.

The last point is important. A backend may refuse an unsupported external ABI or
an experimental target. It must not reject a closed, well-typed source program
merely because structural subtyping reached two physical shapes. That is a
failure of specialization, not a new source-language restriction.

## 2. The semantic pipeline

The trusted story is a sequence of translations and judgments:

```text
UTF-8 source
  -> baba CST
  -> fixity fold and surface elaboration
  -> phased core
  -> algebraic-subtyping inference
  -> coverage and relational proof checking
  -> ownership checking
  -> staging and specialization
  -> validated Runtime HIR
  -> closed Blot public layout
  -> direct Rust/WebAssembly emission
  -> WebAssembly plus canonical adapters
```

Write these stages as:

```text
s parse-> cst elaborate-> e check-> e_typed
  refine-> e_safe own-> e_owned stage-> e_runtime
  specialize-> g lower-> wasm
```

Each arrow has a contract.

| Boundary                     | Required property                                            |
| ---------------------------- | ------------------------------------------------------------ |
| source to CST                | token identity is fixed and the parse is unique              |
| CST to core                  | scope, control, and evaluation order are preserved           |
| core to typed core           | inferred terms satisfy the declarative typing relation       |
| typed core to safe core      | cases cover and proof-required operations have evidence      |
| safe core to owned core      | linear and affine obligations are discharged on every path   |
| owned core to runtime core   | erased compile-time terms cannot affect residual behavior    |
| runtime core to Runtime HIR  | structural uses are specialized and representation is closed |
| Runtime HIR to public layout | Blot's representations and ABI policy are closed             |
| Runtime HIR to Wasm          | validation succeeds and generated code simulates the runtime |
| private values to ABI        | lifting and lowering validate and preserve public values     |

No later stage may reconstruct a fact owned by an earlier stage. Inference
records field sets, constructor sets, effect identities, and coercions.
Refinement records proofs. Ownership records consumption. Lowering consumes
those facts and fails as a compiler invariant if one is absent.

## 3. Concrete syntax and elaboration

### 3.1 Parse soundness

`grammar.baba` remains the authority for concrete acceptance. The grammar is
sound for the language when it satisfies four properties:

1. every byte accepted as part of a token has one terminal identity;
2. every accepted token stream has one compact CST under Baba's CPU frontend;
3. compact CST materialization preserves the rule, field, token, and span
   information required by elaboration; and
4. elaboration is defined for every accepted CST.

The GPU throughput profile is therefore part of the language's metatheory. It is
not a performance test applied after syntax design. A grammar conflict that
requires a parser-resolution override is evidence that source meaning depends on
sequential context and must be redesigned.

Operator precedence is deliberately absent from the grammar. The parser emits a
flat chain, and a lexical fixity environment folds it afterward. A valid fixity
fold must be deterministic, must reject undeclared or incompatible chains, and
must resolve an operator to the binding denoted by its declared path. The
spelling `+` has no intrinsic arithmetic meaning.

### 3.2 Surface forms are translations

The following are surface forms only:

- `for` and `break`;
- statement `if` and deconstructing guards;
- early `return`;
- `try` handler composition;
- element statements;
- declaration tags;
- `open`; and
- optional element properties.

Their elaboration must be hygienic. Compiler-generated names are atoms outside
the source identifier space, not strings that a source program might bind.
Elaboration also preserves source spans so a diagnostic on generated core can be
attributed to the source construct that required it.

For every surface typing derivation there should be a core derivation:

```text
Gamma |-surface s : A ! epsilon
--------------------------------  elaboration preservation
Gamma |-core elaborate(s) : A ! epsilon
```

Operationally, elaboration should commute with evaluation up to compiler-local
administrative steps:

```text
evaluate_surface(s) = observe(evaluate_core(elaborate(s)))
```

### 3.3 Elements are ordinary component applications

An element has no built-in DOM, renderer, node type, or text operation.

```blot
_ <- <Button .label="Save">
  _ <- text "ready";
</Button>;
```

The element expression itself elaborates to an ordinary component call whose
second argument is a nullary child computation:

```blot
Button { .label = "Save"; } (fn () => do
  _ <- text "ready";
end)
```

The surrounding `_ <-` is what sequences and discards that application. A named
bind retains the component's result, and a tail element returns it as the tail
of the enclosing computation. Element syntax therefore changes neither the
component's result nor its effect row.

The component decides whether and how often to execute its children, subject to
the child's ownership contract. An unrestricted child may be called repeatedly;
a child capturing a linear resource is itself linear and may be called exactly
once.

Property omission uses a general, type-directed record-completion coercion. If a
callee's uniquely inferred parameter record contains `.disabled = Bool | ()`, an
argument omitting that field is elaborated with `.disabled = ()`. Element syntax
is the common use, but an ordinary function call may use the same coercion.

Completion is not record width subtyping. It is an explicit operation recorded
in typed core, and reflection after the call observes the completed field. It
may run only at a boundary with one known expected record; an unconstrained
record does not spontaneously gain fields, and competing expected records make
elaboration ambiguous and are rejected. These rules give omission one result
independent of the path by which inference discovered the expectation.

## 4. Core language

The metatheory distinguishes values from computations even though the surface
grammar uses one expression category.

### 4.1 Types

Let value types be:

```text
A, B ::=
    Bottom | Top
  | Unit | Int[l, h] | Text[l, h]
  | F32 | F64 | F32x4 | F32x4Mask
  | A -> (B ! epsilon)
  | { f_i : A_i }
  | [A]
  | < K_i : A_i >
  | A union B | A intersection B
  | forall a. A
  | Seal(n, A)
  | Opaque(n)
```

`A ! epsilon` is an internal computation type: a computation returning `A` and
possibly performing operations in `epsilon`. Surface display may continue to
write `A -> B ~ { E }` for `A -> (B ! {E})`.

Integer and text ranges are inclusive. A singleton literal is a range whose
bounds coincide. Floats are not singleton ranges: IEEE NaN and the absence of a
source-level successor operation make the integer/text interval algebra
inapplicable.

### 4.2 Terms

The essential value and computation forms are:

```text
v ::= () | n | text | lambda x. c | record | array | K v | seal v

p ::= v | x | p p | p.f | pure primitive applications
    | if p then p else p | case p of ...
    | let x = p in p

c ::= return p
    | bind x <- c in c
    | apply p p
    | op[ell, name] p
    | handle ell c with h
    | if p then c else c
    | case p of K_i x_i => c_i
```

This grammar is explanatory rather than a replacement parser. Surface
elaboration may use administrative normal form, closures, and compiler-local
control sums, provided their erasure implements these forms.

Application appears in `p` only when the function's row is empty; otherwise it
is a computation `c` and must occur under `bind` or in a computation branch. A
first-class delayed computation is represented by the ordinary value
`lambda (). c`, matching Blot's nullary-function convention rather than adding a
second thunk type to source.

### 4.3 Liveness-erased pure bindings

`let x = p; body` is strict if the binding is live and absent if it is not.
Before evaluation, a lexical liveness pass removes a pure declaration whose
binding cannot be reached from the block result or another live declaration. The
remaining declarations evaluate exactly once in source order before the block
result. There is no run-time thunk and no first-use forcing rule.

This is not laziness. It is dead-definition elimination made part of the source
semantics, followed by ordinary call-by-value evaluation.

Once demanded, a pure expression evaluates deterministically: the function
position precedes its argument, and tuple, array, record, and constructor
payloads evaluate in source order. `if` evaluates only its selected branch. ABI
field sorting is a layout rule and does not retroactively change source
evaluation order.

The distinction makes three existing design goals compatible:

- an unused pure binding can be erased;
- total pure bindings can be reordered when their lexical dependencies permit;
- traps or divergence in an unused definition do not occur.

An optimizer may erase an unreferenced `let` or inline a single-use `let` when
doing so preserves the source-order trap and divergence observations. It may
reorder only expressions proved total. It may not move a demanded computation
across `<-`, a handler, or a branch that changes whether it is live.

`const` is the phase-1 analogue. The compiler evaluates a live `const` once in
source order and erases it from residual code. Compile-time divergence is a
build that does not terminate unless bounded by the implementation's fuel
policy; fuel exhaustion is a compiler diagnostic, not a source value.

`x := p` is another pure definition that shadows `x`; it neither mutates nor
forces the previous binding. Its additional typing premise requires the old and
new stable types to be equivalent in both subtyping directions. A repeated
`let x = p` is the form that may shadow with a different type. Each non-alias
definition receives a fresh value identity for refinement and ownership facts.

### 4.4 Computation sequencing

`x <- c` is the only surface declaration that incorporates the effects of `c`
into the current computation. The expression on the right is already applied:

```blot
request <- Runtime.request ();
```

does not elaborate by adding `()`. It elaborates as:

```text
bind request <- elaborate(Runtime.request ()) in ...
```

`let x = c` is rejected when `c` has a non-empty effect row. It creates neither
an implicit bind nor an effect thunk.

The value carried by a scoped return is a tail computation rather than an
intermediate definition. It contributes its effects and result directly to the
enclosing module or explicit block, so no redundant bind is required around the
final computation:

```blot
fn () => do
  _ <- first_effect ();
  return final_effect ();
end
```

A conditional can select a computation branch without sequencing it into the
surrounding scope. Thus the clean form for effectful branching is:

```blot
_ <- case x of
  1 => effect,
  _ => other_effect
end;
```

The `case` is itself a computation term; the outer `<-` sequences the selected
branch. If `do _ <- effect; end` is admitted as a convenience, it elaborates to
the same computation form and does not alter this rule.

## 5. Phases and “types are values”

### 5.1 One expression language, two availability judgments

“Types are values” means type expressions use the same source syntax and
compile-time evaluator as other compile-time programs. It does not mean the
metatheory assumes an inconsistent `Type : Type` universe.

The checker uses two environments:

```text
Delta |-ct p downarrow w       compile-time evaluation
Gamma |-rt p : A ! epsilon     run-time typing
```

Run-time variables cannot occur in `Delta`. A `const`, signature, effect
descriptor, fixity descriptor, declaration tag, or reflection request is
accepted only if all of its free variables are available at compile time.
Compile-time evaluation cannot invoke a source or host effect. Its only stateful
operations are compiler-owned identity allocation and dependency-resolved file
loading, both recorded so later passes observe the same result. A decoder over
loaded bytes, such as JSON decoding, is pure.

Compile-time values include a family of well-formed type representations:

```text
TyRep ::= TIntRange(l,h) | TTextRange(l,h) | TUnit | TArray(TyRep) | ...
```

The bridge is a partial, checked function:

```text
bridge : CTValue -> Result<CoreType, Diagnostic>
```

It succeeds only for a well-formed type representation. A closure that computes
a type is not itself a type; it must be applied at compile time first. There is
no source-level type namespace, but the metatheory still has the sort `TyRep`.
Removing a source grammar category does not remove the need to say which values
the checker may interpret as types.

The representation need not be visibly tagged in source. In a type context,
`bridge(42)` may produce the singleton range `Int[42,42]`, a constructor value
may produce a variant case, and a record whose fields all bridge may produce a
record type. The bridge, rather than the general evaluator, is what gives those
ordinary compile-time values their type-denoting interpretation.

A compile-time decoder may deliberately choose a sound type wider than
`bridge(w)`. Model its result as evidence `(w, A, p)` where `p` proves `w : A`.
The value observed by evaluation and lowering remains `w`; inference reads `A`.
This is an elaboration artifact rather than a second runtime value. Exact JSON
decoding chooses `A = bridge(w)`, while ordinary JSON decoding recursively
widens literal leaves and joins array element types. No decoder may attach a
type without constructing the corresponding inhabitation evidence.

### 5.2 Predicativity and reflection

`forall` is predicative. An inference variable may be instantiated with a
monotype, never with another quantified type. A quantified requirement is
checked by skolemization.

Reflection returns a typed description whose payloads preserve their
relationship to the reflected type. It must not return unconstrained fresh
variables that a later signature can specialize arbitrarily. There are two sound
implementation choices:

1. use an indexed internal reflection type and erase the index after checking;
2. give each saturated reflection operation a call-site typing rule derived from
   its statically known `TyRep`.

The current practice of assigning `Top` or an unconstrained inference variable
to a payload is not evidence that the payload has any requested type.

### 5.3 Compile-time identities

Effects are generative capabilities. An effect declaration allocates a fresh
compile-time atom, and equality is atom identity rather than structural equality
of the operation descriptor. Allocation is stable for one module evaluation and
deterministic under the compiler's module cache.

```text
newEffect(Sigma) downarrow effect(ell, Sigma)   where ell is fresh
```

Staging must preserve the atom across inference and lowering. Re-evaluating the
same source node in a later pass must retrieve the recorded value, not mint a
new identity.

Seals are instead applicative named types:

```text
seal(name, A) = seal(name, B)  iff  A = B
```

The carrier participates invariantly in identity. Thus `List I32` is the same
type every time its ordinary compile-time constructor runs, while `List I32` and
`List Str` are distinct. Choosing the same public name and carrier chooses the
same seal even across modules. A future abstraction capability that cannot be
reconstructed from public inputs would be a separate generative primitive;
making `seal` itself fresh would invalidate ordinary parameterized nominals.

## 6. Algebraic subtyping and inference

### 6.1 Declarative subtyping

The core subtyping judgment is `A <: B`. Representative rules are:

```text
Int[l1,h1] <: Int[l2,h2]       when l2 <= l1 and h1 <= h2

{ f_i : A_i, g_j : B_j } <: { f_i : A'_i }
                                when A_i <: A'_i for every required f_i

< K_i : A_i > <: < K_i : A'_i, L_j : B_j >
                                when A_i <: A'_i

A2 <: A1    B1 <: B2    epsilon1 subset epsilon2
--------------------------------------------------
A1 -> (B1 ! epsilon1) <: A2 -> (B2 ! epsilon2)
```

Arrays are covariant only while immutable. An owned in-place update is an
implementation of a persistent operation and does not make source arrays
mutable. If an array reference ever becomes externally mutable, array element
types must become invariant.

Records use width and depth subtyping. Variants use the dual case-set ordering:
fewer possible constructors is more precise. Effect rows are finite sets of
generative labels ordered by inclusion; fewer escaping effects is a subtype.
Seals compare only when their generative atom is identical and are invariant in
their carrier. A namespace attached to a type representation is compile-time
metadata and is transparent to run-time subtyping; it is not another field on
every value of that type.

### 6.2 Inference and principal types

Simple-sub-style variables carry lower and upper bounds. Biunification
propagates `A <: B` constraints and generalizes live pure bindings. The
algorithmic claim should be stated narrowly:

> For the rank-1 algebraic core, after compile-time expressions required for
> checking have normalized, inference returns a principal type modulo type
> equivalence, or a diagnostic.

Arbitrary compile-time computation, explicit Rank-N types, type reflection, and
relational checking are outside the principal-inference theorem. They are
checked phases that consume the inferred ordinary types.

The implementation must be proved sound with respect to the declarative
relation:

```text
infer(Gamma, e) = A
---------------------
Gamma |- e : A
```

Completeness and principality are desirable separately. A conservative refusal
can preserve soundness while losing completeness. Accepting a term by assigning
an unconstrained variable where the checker has no evidence loses soundness.

### 6.3 Signatures and coercions

A signature is checked by subsumption and then becomes the binding's published
type. Every use of subtyping that changes representation records an explicit
coercion in typed core.

Most source subtyping is representation preserving. Two cases are not safely
left implicit:

- a structural record specialized to a nominal Core record; and
- an omitted record field completed with `()`.

Specialization may clone a polymorphic function once per concrete record shape,
or pass a layout dictionary. It may not infer a narrower nominal shape from the
fields a function happens to read and then apply that nominal to a wider value.

Core record field names are static. `@shape.get r name` is an ordinary
projection when `name` is known at compile time. A genuinely run-time name is
rejected for a structural record; programs needing run-time lookup use a
homogeneous dictionary returning `Option A`. A future existential `Dynamic` may
relax this, but an unconstrained inference variable is not its encoding.

## 7. Refinements and relationships

### 7.1 Why relationships are separate

The ordinary type `[A]` says every element has type `A`. It does not say how
many elements a particular array value contains. Length belongs to a value
identity, not to the array type constructor.

The checker therefore maintains a refinement context `Phi` in addition to the
type environment `Gamma`:

```text
Gamma; Phi |- e : A ! epsilon
```

`Phi` contains propositions over immutable value identities:

```text
phi ::= x = y | x = n | x = y + n
      | 0 <= x | x < length(alpha)
      | length(beta) = length(alpha) + n
      | InBounds(alpha, x)
      | phi and phi
```

Here `alpha` names one immutable array value. An alias preserves `alpha`; a
persistent update creates a new identity and records the length relation it
preserves; append creates `beta` with `length(beta) = length(alpha) + 1`.
Shadowing with an unrelated value creates a fresh identity.

The first solver should remain decidable and deliberately small: equality,
literal affine offsets, interval intersection, and same-identity array lengths.
This is sufficient for loops and bounds without turning biunification into a
dependent solver. A future Presburger solver may replace it behind the same
entailment judgment:

```text
Phi entails phi
```

Failure to prove means “use the total operation,” not “the operation is probably
safe.”

Functions may carry an erased relational summary in addition to their ordinary
type and ownership summary:

```text
requires phi_in; ensures phi_out
```

Application substitutes the caller's value identities into the summary. The
compiler may infer simple summaries, while a prelude or host primitive may
declare one through a compile-time descriptor. A declared summary is a proof
obligation checked against the body or against the primitive's trusted contract;
it is never believed like an unchecked annotation. This mechanism lets a wrapper
around `length`, a slice constructor, or an iterator preserve facts without
placing those facts in the algebraic type lattice.

### 7.2 Safe and direct array operations

The total interface is:

```text
get    : [A] -> Int -> Option A
set    : [A] -> Int -> A -> Option [A]
length : [A] -> Int
```

It performs one semantic bounds decision and returns `None` when the index is
outside the array.

Every array identity also satisfies `0 <= length(alpha) <= MAX_ARRAY_LENGTH`.
The implementation defines `MAX_ARRAY_LENGTH` no larger than its Store and
memory32 representation can support; allocation or growth beyond it is a
specified trap. The bound is part of the primitive contract, not inferred from
`[A]`.

The direct core operations have proof premises:

```text
Gamma; Phi |- a : [A]       Gamma; Phi |- i : Int
Phi entails 0 <= i < length(identity(a))
--------------------------------------------------
Gamma; Phi |- get_proved(a, i) : A
```

and analogously for `set_proved`. A direct source primitive is accepted only
when the premise holds. It must be saturated at that source site: aliasing or
partial application would separate the eventual index from the proof premise and
is rejected. Lowering may emit an unchecked Store access because the proof is
part of typed core. If the target has no unchecked operation, lowering may
retain a defensive check, but the optimizer should not need to rediscover the
source proof from machine-level comparison operators.

This yields a simple check-count rule:

- total access: one run-time bounds decision;
- proved direct access: zero run-time bounds decisions;
- an unproved direct access: compile-time rejection.

### 7.3 Proof-carrying iteration

An indexed array iterator conceptually yields an erased dependent package:

```text
exists i : Int, x : A.
  Proof(0 <= i < length(alpha) and x = select(alpha, i)) * (i, x)
```

The source sees `(i, x)`. While the loop body is checked, `Phi` receives the
package's proposition. It can therefore use `i` for another proved read or write
of the same array without repeating a check. Iterating values alone already
carries the selected `x`, so the body performs no second lookup.

Proof packages are erased and cannot be forged by ordinary source values. A
prelude iterator obtains one through a proof-producing array primitive or a
checked relational contract; `for` does not recognize `Iter.indexed` by name.
This preserves the rule that surface syntax does not depend on a lexical binding
having a magical spelling.

More general structures use the same mechanism. A vector may relate its logical
length, capacity, and backing Store. A slice may carry
`start + length <= length(base)`. A parser cursor may carry
`offset <= length(input)`. None of those facts changes the element type.

### 7.4 Branches introduce proofs

Conditions refine `Phi`, not mutable inference variables. For example:

```blot
if i >= 0 && i < Array.length values then
  @array.get values i
else
  fallback
end
```

checks the first branch under:

```text
Phi, 0 <= i, i < length(identity(values))
```

The else branch receives the logical negation only when the solver can represent
it. A solver that cannot represent a consequence records nothing and remains
sound.

Operators are recognized by their compile-time semantic descriptor, not their
source name. Shadowing `==` or `&&` must not preserve the proof behavior of the
binding they replaced.

## 8. Pattern matching and control

### 8.1 Exhaustiveness is a safety property

A closed `case` must either be statically exhaustive or contain an irrefutable
arm. Inference uncertainty is not permission to emit a latent `no match` trap.
If the checker cannot enumerate or otherwise prove coverage, it requires `_`.

Coverage operates on the cross-product of pattern columns, including nested
tuples and constructor payloads. Guards do not cover a row unless their truth is
statically guaranteed. Float literal patterns never exhaust `F64`, because NaN
and all other values remain.

The coverage theorem is:

```text
Gamma |- v : A    covers(A, arms)
----------------------------------
some arm matches v
```

A source-level `@panic` in a catch-all arm is an explicit specified trap and
does not count as match failure.

### 8.2 Value conditionals do not transfer control

Expression `if` and `case` produce values or computations selected from their
branches and do not establish statement control targets. An explicit `do` branch
is a local return scope, while `break;` cannot cross the value expression to
reach an enclosing loop. Statement conditionals elaborate with compiler-local
control sums whose cases are eliminated at the corresponding loop or
return-scope boundary.

This keeps non-local control explicit in core and prevents a value expression
from having a hidden continuation target.

### 8.3 Loops are folds

`for` elaborates to recursion over an iterator protocol. Names rebound by `:=`
form an accumulator record. `break;` returns that record from the nearest loop;
`return` carries a compiler-local result through the repeated body to the
nearest enclosing module or explicit `do` boundary.

Downstream passes see recursion, cases, records, and computations. They do not
contain a second loop semantics. The elaboration must preserve relational
evidence yielded by the iterator and ownership state carried in the accumulator.

## 9. Effects and handlers

### 9.1 Effect identities and rows

An effect value is a generative label `ell` paired with an operation signature:

```text
Sigma(ell)(op) = A -> B
```

Performing `op` has the judgment:

```text
Gamma |- v : A
--------------------------------
Gamma |- op[ell, op](v) : B ! {ell}
```

Rows combine by set union. A pure computation has the empty row. Function
application contributes the row on the function's final arrow.

Rows account for algebraic and host operations, not termination. A computation
with an empty row may still diverge or reach a specified arithmetic or panic
trap when demanded. Those outcomes are part of the operational semantics rather
than forgeable effect labels, which is why demand preservation—not an empty row
alone—justifies dead-definition elimination.

Effect labels are capabilities at compile time: a program cannot name or handle
an effect identity it did not receive through lexical scope or a module
interface. At run time, ordinary source effects are compiled away by handler
specialization. Host effects remain as imports.

### 9.2 Handler semantics

A handler for `ell` contains one clause for every operation it handles and an
optional return clause. Reduction captures the delimited continuation from the
operation to the handler:

```text
handle ell (E[op[ell,name](v)]) with h
  --> h.name(v, resume = lambda b. handle ell (E[return b]) with h)
```

Operations with another label pass through. The result row removes `ell` and
adds effects performed by handler clauses:

```text
Gamma |- c : A ! (epsilon union {ell})
Gamma |- h : Handler(ell, A, B, epsilon_h)
------------------------------------------------
Gamma |- handle ell c with h : B ! (epsilon union epsilon_h)
```

`resume` is one-shot, but its lower usage bound depends on what the captured
continuation owns. When the continuation closes over a live linear obligation,
`resume` is linear and the clause must call it exactly once. Otherwise it is
affine and the clause may call it zero or one time. Zero aborts the captured
continuation only when doing so cannot discard a linear resource; one continues
it; two is always rejected. A linear continuation may instead be consumed by the
explicit operational computation `Continuation.cancel resume`. Cancellation does
not enter the captured evaluation context; it discharges the continuation's
structural ownership obligation and produces `Unit`:

```text
cancel(resume = lambda b. handle ell (E[return b]) with h) --> ()
```

The checker admits this rule only at a binding identity proved to be a resume
parameter of the statically known handler. Its internal computation marker is
removed by that enclosing handler, but still prevents a pure `let` from erasing
or reordering cancellation.

The run-time evaluator may retain a defensive one-shot flag, but accepted source
does not depend on that flag to prevent a second resume. This interaction is why
effect checking and ownership may be separate judgments but cannot be unrelated
passes: the typed handler determines the continuation boundary, and ownership
determines whether its use is affine or linear.

### 9.3 Host effects

An ordinary effect row must be empty at the module boundary. A host effect row
is an external capability declaration and lowers to typed synchronous imports.
The entry module parameter and explicitly supplied host effects are the only
ambient authority.

Host calls may diverge, trap, or violate their contract. Canonical adapters
validate representational claims before constructing a Blot value. Once lifted,
the interior semantics may assume the value is well formed.

## 10. Ownership and borrowing

### 10.1 A separate usage judgment

Ownership is checked after ordinary typing and refinement:

```text
Gamma; Phi; Omega |- e : A ! epsilon => Omega'
```

`Omega` maps binding identities to obligations:

```text
U   unrestricted: any number of uses
A   affine: zero or one consuming use
L   linear: exactly one consuming use on every terminating path
B   borrowed view: projections and borrowed calls only; no move or escape
```

The typing lattice never asks whether a value is linear. The usage judgment
never reinfers its ordinary type.

Branches begin with the same `Omega`. Their output states must agree for linear
obligations; affine outputs join conservatively and may be unused. A handler
continuation is affine when aborting is ownership-safe and linear when its
captured continuation owns a linear obligation.

Every function also has an ownership summary, inferred or checked separately
from its ordinary arrow:

```text
q A -> B    where q is unrestricted, borrow, affine, or linear use of A
```

This is metadata on typed core, not a new subtype constructor. A parameter used
twice requires an unrestricted argument. A parameter consumed exactly once may
accept a linear argument. A borrowing parameter may inspect but not retain its
argument. At application, the caller checks the argument's obligation against
this summary. Without this interprocedural contract, passing a linear closure to
an ordinary function that calls its parameter twice would duplicate the
closure's captured resource while appearing only once at the call site.

### 10.2 Closures and structures

A closure owns its captured environment. Its obligation is the join of the
obligations it captures:

- a linear capture makes the closure linear;
- otherwise an affine capture makes it affine;
- borrowed values may be captured only when the closure cannot outlive the
  borrow scope; and
- unrestricted captures impose no obligation.

Recursive closures may capture spendable values only when an SCC certificate
shows that every recursive occurrence is an ownership-tail edge, each recursive
path takes exactly one such edge, and an external call consumes the SCC as one
owned knot. Other recursive captures are refused; traversal order is never a
call-count proof.

Ownership propagates structurally. A tuple, record, constructor, or array
containing a linear value is itself linear; one containing only affine and
unrestricted values is at most affine. Moving the structure moves its
obligations. Borrowing it permits read-only projections without extracting an
owned field.

Extraction must account for every obligation in the container. Projecting one
owned field may consume the whole record only when every omitted field is
unrestricted; otherwise a pattern must destructure all owned fields. Ordinary
array `get` is unavailable for an array of spendable elements because returning
one element while retaining or discarding the array would duplicate or lose the
rest. Such an array needs a consuming `take`/`split` operation that returns both
the selected element and a remainder carrying every other obligation. Until
those operations exist, the checker conservatively rejects the extraction.
Spreads are likewise accepted only when no owned location becomes ambiguous;
known literal append preserves its new element position.

This closes the “linear closure cannot be stored” gap for known aggregate
structure. Consuming array extraction remains conservative until a split
operation can return every remaining obligation.

### 10.3 Borrows are lexical views

The minimal Blot borrow is not a general reference with an inferred lifetime. It
is a lexical, non-storable view accepted only as an argument to a borrowing
parameter or for immediate projection. It cannot be returned, inserted into a
structure, captured by an escaping closure, or passed to a host.

This restriction admits a simple no-escape theorem without adding lifetime
parameters to the type lattice. If first-class slices or references are added,
Blot will need an explicit provenance/region calculus rather than extending the
current marker informally.

### 10.4 Reuse theorem

Source arrays are immutable. An implementation may update an array allocation in
place only when ownership proves that no source-observable alias can be used
after the update.

```text
linear consumption of a at set(a,i,v)
Phi entails InBounds(a,i)
---------------------------------------
destructive Store write is permitted
```

The semantic result remains a new array value. Reuse is validated by a
simulation relation equating the persistent source array with the uniquely owned
target Store before and after the update.

Traversal-order “last use” alone is not this proof. Closure execution order,
branches, and recursion can all make a syntactic last occurrence differ from a
semantic death.

## 11. Modules and capabilities

A module is a unary function from its explicit parameter to its result. A file
without a parameter is a function from `Unit`. Import resolves and returns that
function; it does not invoke it.

The parameter is the module's authority. Imports do not grant filesystem or
network access. A library observes only the record or capability value its
caller supplies.

Module checking may be separate, but specialization is whole-program over the
resolved module graph. Facts attached to an imported definition are keyed by
node or binding identity, never by a source name. Recursive import cycles are
rejected unless a future module semantics gives them an explicit fixed point.

The prelude is an ordinary module. Default fixity entries contain paths, not
bindings; an operator works only after its target binding is in lexical scope.

## 12. Numeric and storage domains

### 12.1 Run-time integers

The run-time `Int` domain is exactly the signed 64-bit mathematical interval:

```text
Int = [-2^63, 2^63 - 1]
```

Arithmetic either returns the corresponding mathematical result when it lies in
`Int` or produces the specified integer-overflow trap. Division by zero and the
signed division overflow case are specified traps. Compile-time integers are
arbitrary precision, so lowering a compile-time integer into run-time code
requires a representability check.

Range types over run-time integers must be subsets of `Int`. Consequently, a
source type called `U64` cannot simultaneously mean the full interval
`[0, 2^64-1]`, use ordinary signed `Int` operations, and have every inhabitant
represented by one run-time `Int`. One of those claims must change.

The sound model separates numeric ranges from storage widths:

- `I(n)` and `U(n)` may compute layout descriptors for any positive `n`, and may
  also denote run-time range types when the complete range fits `Int`;
- an ordinary run-time range type is admitted only when its bounds fit `Int`;
- a future `Word(n)` or `UInt(n)` is a distinct bit-vector domain with explicit
  wrapping or checked operations and an explicit ABI representation.

Thus packed layout metadata may describe an unsigned 64-bit field before Blot
has a run-time `UInt64` value type. Attempting to bridge that descriptor as an
ordinary run-time range is a diagnostic. Metadata does not make an
unrepresentable integer inhabit `Int`.

### 12.2 Packed layouts

`packed` is a compile-time source function producing a layout description: field
order, bit offsets, widths, masks, total bits, and trailing bits. It does not by
itself change the run-time representation of a source record. Loading or storing
that packed representation requires explicit operations whose numeric domain and
endian behavior are specified.

This prevents a namespace attachment such as `.bit_width` from becoming an
unspoken promise about every run-time value of the attached range.

## 13. Runtime representation and the ABI

### 13.1 Abstract source values

The source semantics does not expose backend tags, constructor numbers, Store
headers, object addresses, or Wasm words. Arrays are finite sequences; records
map source field names to values; variants contain a constructor name and
payload; seals carry nominal identity.

Lowering chooses private representations and proves a relation `R_A(v, w)`
between a source value `v : A` and a target value `w`. For every source step,
the target may take zero or more administrative steps and reach a related state.
This forward simulation is the basis of compiler correctness.

### 13.2 Specialization before Runtime HIR

Blot accepts algebraic subtyping while Runtime HIR requires closed physical
representations. Therefore Blot must make every residual use representable:

- instantiate polymorphism;
- choose concrete record and variant representations;
- insert or discharge coercions;
- specialize handlers;
- erase refinement evidence and compile-time values; and
- make ownership permissions explicit on Store operations.

A Runtime HIR validation failure for a well-typed closed Blot program is a Blot
lowering bug. It is not resolved by weakening the source type claim.

Runtime HIR, its validator, ABI manifests, canonical adapters, module shell, and
direct emitter live in Blot. One closed public layout supplies both the manifest
and adapter representation. Gpupaper is an external conformance oracle; it does
not infer or recreate any production Blot representation, effect identity, or
ABI rule.

### 13.3 Public ABI

The stable Core Wasm ABI is a pair of total boundary functions, modulo explicit
validation failure:

```text
lift_A  : caller bytes/values -> Result<source A, trap>
lower_A : source A -> caller bytes/values plus ownership obligation
```

For every valid public value:

```text
lift_A(lower_A(v)) = v
```

up to allocation identity and canonical ordering. Malformed UTF-8, booleans,
discriminants, lengths, pointers, and alignments trap before an invalid source
value enters the program.

Gpufuck's private tagged values never cross this boundary. ABI record order,
variant discriminants, seals, flattening, post-return ownership, and allocator
behavior are part of a versioned external contract. Internal representation
changes do not require an ABI change; incompatible public layout or ownership
changes do.

## 14. Soundness statements

The paper's target is a collection of smaller theorems rather than one vague
claim.

### 14.1 Progress with classified outcomes

If a closed computation is well typed with row `epsilon`, then it is one of:

- `return v` for a value of the promised type;
- able to take a reduction step;
- poised to perform an operation whose label is in `epsilon`;
- divergent; or
- at a specified language trap.

It is not stuck on a missing case, forged proof, invalid internal record field,
second affine continuation use, or out-of-bounds proved access.

### 14.2 Preservation

If `Gamma; Phi |- c : A ! epsilon` and `c -> c'`, then there exist updated
environments consistent with allocation and demand such that
`Gamma'; Phi' |- c' : A ! epsilon`. Evaluation may enter a binding or allocate
an immutable identity, but cannot change the promised result or introduce an
unaccounted effect.

### 14.3 Phase safety

Residual run-time code is closed over compile-time bindings after erasure.
Changing or removing an erased `TyRep`, fixity descriptor, effect signature, or
layout descriptor cannot change run-time behavior except through the residual
code it generated.

### 14.4 Ownership safety

No execution of accepted core duplicates a linear obligation, consumes an affine
obligation twice, moves through a borrow, or allows a borrow to outlive its
owner. Every demanded linear binding is consumed exactly once on every
terminating path leaving its scope.

### 14.5 Bounds safety

Every `get_proved` and `set_proved` step has an index within its array. Every
other source array access uses the total `Option` operation. Consequently, an
accepted program cannot reach an array-bounds trap through source operations.
Defensive target checks may remain but are unreachable for proved operations.

### 14.6 Compilation agreement

For a closed program and the same sequence of host responses, the reference
evaluator, independent conformance evaluator, and emitted Wasm produce
observationally equivalent exports, host operations, specified traps, or
divergence. Allocation identity and internal administrative steps are not
observations.

## 15. What the model deliberately leaves open

Several choices can be postponed without making the core ambiguous:

- whether the refinement solver grows from difference constraints to full
  Presburger arithmetic;
- whether first-class borrows later introduce regions and provenances;
- whether unsigned words become intrinsic domains or a sealed library type
  backed by compiler operations;
- whether specialization clones functions or passes representation dictionaries;
- whether compile-time normalization is fuel-bounded by the language or only by
  the implementation; and
- which proof assistant, if any, mechanizes the core first.

The interfaces around those choices are fixed: entailment, ownership judgment,
representation coercions, staged erasure, and target simulation.

## 16. Coherence audit of the current language

This section is intentionally direct. “Remaining gap” does not mean the
implementation is useless; it names the part of the model that the current
compiler still does not establish. A row with no remaining gap is backed by an
executable checker or lowering test, not only by documentation.

| Area                     | Current implementation                                                                                                                                                          | Model decision                                                         | Remaining gap                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| pure binding             | liveness erases unused definitions; every remaining definition evaluates once in source order                                                                                   | liveness erasure followed by strict evaluation                         | none                                                                                                 |
| effect sequencing        | typed Core classifies live declarations as `define` or `bind`, gives compiler-owned applications dedicated nodes, records every residual type, and drives reference evaluation  | only `<-` binds a computation into scope                               | migrate the production gpufuck lowerer from the shared source schedule to typed Core                 |
| coverage                 | uncertainty and every unlistable domain require an irrefutable arm; tuple coverage checks the complete cross-product                                                            | accepted closed `case` is exhaustive or has an irrefutable arm         | none for the implemented pattern language                                                            |
| type reflection          | Core carries a graph-form `TyRep` table; saturated reflection is exact, generic payloads cannot authorize runtime work, and phase evidence is separate from inference variables | reflection payloads are indexed or typed at saturated call sites       | none                                                                                                 |
| dynamic shape operations | a run-time field name is rejected; `Dict` provides homogeneous run-time keys with ownership-preserving replacement and removal                                                  | structural fields require compile-time names                           | none                                                                                                 |
| optional fields          | inference records each call's source fields and absent/present/unit adaptations; lowering consumes that fact                                                                    | completion is an explicit type-directed coercion visible to reflection | none for direct record applications                                                                  |
| width subtyping          | runtime lambdas specialize projections, destructuring, direct record/tuple/array members, aliases, imports, and run-time choices per concrete call                              | specialization closes representation for every call                    | represent structural functions that escape through nested aggregates or unknown higher-order results |
| integer domains          | run-time `Int` and `Nat` are signed-i64-bounded; wider `U64` is storage metadata and is rejected in runtime signatures                                                          | run-time `Int` is bounded; storage width is separate                   | add a distinct word domain only if full-width run-time words become necessary                        |
| array proofs             | comparison branches, immutable aliases, and proof-producing iteration populate `Phi`; direct access carries independently replayed evidence                                     | proofs live in `Phi` and reach lowering explicitly                     | none for arrays                                                                                      |
| indexed loops            | `@array.indexed` yields an ordinary iterator plus unforgeable erased packages propagated through projections and patterns                                                       | iterator yields an erased relational package                           | generalize the relational-value channel when another proof-producing collection needs it             |
| ownership of structures  | aggregate obligations propagate; certificates publish every path-specific consumption and gate reuse at that exact site; extraction preserves every branch                      | ownership propagates structurally                                      | publish structural extraction lineage beyond the certified consumption sites                         |
| higher-order ownership   | explicit contracts and ownership-transparent unannotated name parameters carry checked usage summaries; caller obligations substitute through returned closures                 | functions carry separate usage summaries                               | infer summaries through calls, projections, and destructuring                                        |
| recursion and ownership  | a certified SCC may transfer shared spendable captures through exactly one ownership-tail recursive edge per path; other recursion refuses closed                               | recursive ownership requires a semantic call-count proof               | none for the certified ownership-tail class                                                          |
| borrow scope             | transient borrow evidence follows structural arguments; storage, return, ordinary or host passage, and retained closure capture are rejected                                    | borrows are lexical non-escaping views                                 | none for lexical borrows; first-class references would require explicit regions and provenance       |
| handler abort            | a continuation that owns a linear capture requires `!resume`, consumed exactly once by resuming or explicit sequenced cancellation                                              | a continuation owning linear resources has a linear `resume`           | none for statically known handlers                                                                   |
| effect identity          | inference records each declaration's generative value by AST identity; lowering installs and compares those recorded atoms                                                      | generative atoms are allocated once and recorded                       | none for the current inference-to-lowering pipeline                                                  |
| seal identity            | equality compares the public name and invariant carrier                                                                                                                         | seals are applicative named types                                      | none                                                                                                 |
| arithmetic refinements   | public arithmetic types widen normally while `Phi` separately retains supported affine relationships                                                                            | refinement arithmetic is an independent entailment system              | none for the implemented affine fragment                                                             |
| optimizer correctness    | generated pure programs and an ordered host-effect trace compare typed-Core evaluation with direct evaluation; refinement and ownership certificates have mutation tests        | demand and computation traces define observations                      | extend simulations to handlers, staging, generated ownership paths, and target traces                |
| WebAssembly compiler     | the Rust/Wasm target supports only a subset of ABI/runtime HIR                                                                                                                  | target restriction is allowed if it refuses before artifact production | keep target gaps separate from source-language acceptance claims                                     |

## 17. Migration plan

The migration proceeds by establishing one trustworthy boundary at a time.
Compatibility with accidental behavior is not a goal. M0 and M3 are complete;
M1, M2, M4, M5, M6, and M7 now have executable first boundaries, with their
remaining work stated explicitly below.

### M0: Freeze the observation model — complete

Write executable tests for demand, effect order, specified traps, host traces,
and divergence boundaries.

- An unused pure `let` containing a trap is not demanded.
- A demanded pure `let` is evaluated once.
- `<-` executes left to right exactly once.
- Moving a pure definition does not move a computation.
- Case and element child computations execute only when selected/called.

Update `LANGUAGE.md` to state liveness erasure and strict source order. This
resolves the largest semantic contradiction before changing IR.

### M1: Introduce a value/computation core — typed boundary complete

Elaborate the existing AST into an internal fine-grain core with explicit
`return`, `bind`, and operations. Keep surface grammar unchanged.

- Require every effectful surface use to be under `<-` or inside a computation
  value.
- Type Core directly and compare inferred public types with the old checker
  during migration.
- Lower handlers, statement control, and effects from this Core rather than
  pattern-matching ambient AST contexts.

Typed Core now owns residual expression structure, explicit `return`/`bind`,
dedicated nodes for compiler-known applications, and a settled `TyRep` reference
on every node. Live host-effect capabilities stay in Core so erasure cannot
leave their operations unbound. The reference evaluator and Runtime HIR builder
consume typed Core directly. Resolved `open` bindings are Core facts, so
imported scopes require no source-AST replay.

### M2: Make compile-time representations typed — inference boundary complete

Define the internal `TyRep`, effect descriptor, seal descriptor, and reflection
result types.

- Replace unconstrained reflection and dynamic-shape results with indexed
  call-site rules or explicit dynamic results.
- Record generative effect identities once; keep applicative seals
  deterministic.
- Add phase checking before evaluation and staging.
- Reject a run-time dependency in every compile-time context with one phase
  diagnostic.

Saturated reflection is exact and unevidenced generic inspection cannot prove a
signature or determine a runtime operation. Typed Core now contains an explicit
graph-form `TyRep`, including effect rows. Reflection and dynamic-shape
provenance live in a separate phase-evidence table rather than on inference
variables or in the Core representation graph. Effect declarations record their
generative values once, and downstream lowering consumes those recorded atoms.

### M3: Make matching total — complete

Replace permissive unknown coverage with conservative coverage.

- Require catch-all arms for unconstrained targets.
- Check full tuple and nested-pattern cross-products.
- Preserve branch refinements without mutating inference variables.
- Treat an explicit `@panic` catch-all as a program trap, not coverage failure.

Success means `BLOT_NO_MATCH` is unreachable for checked source programs.

### M4: Add a refinement proof IR — complete for arrays

Move array identity and length relations into `Phi`.

- Define identity allocation and alias rules.
- Implement affine equalities and difference constraints.
- Record proof evidence on direct array operations.
- Add proof-producing array iteration.
- Lower proved operations without asking gpufuck to reverse-engineer source
  facts from typed machine comparisons.

Inference now attaches a type-independent certificate to each direct access and
lowering refuses to emit one without successful independent replay. The `Phi`
kernel implements integer difference constraints, affine equality, cloning,
contradiction rollback, and entailment. Recognized comparison branches and
immutable aliases feed the kernel; their assumptions are replayed from the
certificate. Relational bounds have been removed from the public value-type
lattice. `@array.indexed` produces an unforgeable erased relationship package;
ordinary projections and pattern bindings install its index proposition in
`Phi`, and the dynamic Wasm path performs only the iterator step's bounds
decision.

### M5: Close structural specialization — direct calls complete

Record explicit coercions and specialize every residual structural use.

- Clone a structural function per incompatible concrete shape or pass a layout
  dictionary.
- Preserve the full shape when polymorphic identity or spread requires it.
- Ensure gpufuck HM-checks every program accepted by the closed source core.

Runtime `let` lambdas are cloned per concrete record shape through direct calls,
immutable aliases, source forwarders, imports, and transparent identity
applications. Projection, direct parameter destructuring, and a shape nested in
a tuple `case` all use the call-site representation. A function retained in a
direct record, tuple, or literal array remains specializable rather than forcing
one nominal parameter representation. Nested aggregate escape and unknown
higher-order results still need the same treatment.

### M6: Propagate ownership structurally — aggregate propagation complete

Replace the closure-only escape restriction with obligations on aggregates.

- Define obligation joins for records, tuples, variants, arrays, and closures.
- Infer function parameter usage summaries and check them at every application.
- Require consuming split operations for structures containing several spendable
  components.
- Make borrows uniformly non-escaping.
- Make a handler continuation linear whenever aborting it would discard a linear
  obligation.
- Permit an abort of a linear continuation only through explicit sequenced
  cancellation.
- Restrict recursive capture declaratively.
- Continue using linear consumption, not syntactic last use, as Store-reuse
  evidence.

Known aggregates now carry one structural obligation derivation. Checked
function contracts substitute caller obligations through ordinary and returned
results, and ownership-transparent unannotated name parameters infer the same
summary. Transient borrow evidence is rejected at every retaining boundary, and
a linear handler continuation may be cancelled explicitly. A separately verified
certificate now gates backend reuse permissions. General summary inference
through calls, projections, and destructuring remains. The certificate retains
every branch-specific consumption and authorizes reuse only at those exact
occurrences; publishing the structural lineage of each extracted component
remains.

### M7: Separate numeric values from storage descriptions — complete

Constrain run-time integer ranges to signed `Int` and keep arbitrary bit widths
in layout metadata. Decide later whether distinct word types are worthwhile.

- Refuse a run-time signature containing unrepresentable integer inhabitants.
- Test every arithmetic trap across evaluator, gpufuck, and Wasm.
- Specify packed load/store operations before claiming packed run-time records.

Success means every inhabitant of a run-time type has a run-time representation.

### M8: Establish compiler simulations

Build the proof/testing ladder from the small core outward.

- property-test elaboration against direct surface evaluation;
- property-test inference soundness on generated typed terms;
- check refinement certificates independently;
- check ownership certificates independently;
- differential-test staged and unstaged evaluation;
- retain evaluator/GPU/Wasm agreement for the whole corpus; and
- mechanize the smallest core once its rules stop changing.

The first mechanized artifact should omit modules, reflection, SIMD, and the
ABI. It should include live bindings, functions, variants, effects, handlers,
and affine continuations, because those choices determine the rest.

`formal/lean` is the first checked boundary. It pins Lean 4.32.2 and defines
separate value and computation syntax with functions, variants, explicit effects
and handlers, plus a one-shot continuation state. Its initial lemmas establish
that pure definitions preserve the observation, binds concatenate effect traces
in source order, a successful resume spends its continuation, and a spent
continuation cannot resume. Substitution, typing, handler reduction,
preservation, and progress remain before this is a metatheory of the source
language.

## 18. Validation strategy

Examples are executable specification, but examples alone cannot cover a
metatheory. Each soundness layer needs a different test oracle.

| Property                | Practical oracle                                               |
| ----------------------- | -------------------------------------------------------------- |
| token/parse determinism | Baba generation gate plus CPU compact-CST corpus tests         |
| elaboration             | golden core plus surface/core differential evaluation          |
| inference               | principal-type snapshots and generated declarative derivations |
| coverage                | generated finite domains and mutation of missing rows          |
| refinements             | certificate replay by a small independent checker              |
| ownership               | path-generated terms plus certificate replay                   |
| staging                 | staged/unstaged contextual equivalence tests                   |
| specialization          | gpufuck HM re-check with no source-accepted shape refusal      |
| backend                 | evaluator/GPU/Wasm differential execution                      |
| ABI                     | round-trip properties and malformed-input trap tests           |

The certificate checkers should be smaller than the analyses that produce them.
An optimizer or solver may be complicated; the trusted evidence format should
not be.

## 19. Research context

Blot combines existing lines of work but should not claim their theorems by
association.

- Parreaux's
  [The Simple Essence of Algebraic Subtyping](https://cse.hkust.edu.hk/~parreaux/publication/icfp20/)
  motivates the lower/upper-bound inference engine and compact principal types.
- Levy's
  [call-by-push-value](https://link.springer.com/book/10.1007/978-94-007-0954-6)
  motivates making the value/computation boundary explicit, although Blot's
  liveness-erased pure declaration is its own surface choice.
- Bauer and Pretnar's
  [Programming with Algebraic Effects and
  Handlers](https://arxiv.org/abs/1203.1539) and
  [effect system for core Eff](https://arxiv.org/abs/1306.6316) provide the
  algebraic and type-safety setting for operations and handlers.
- Lindley, McBride, and McLaughlin's [Frank](https://arxiv.org/pdf/1611.09259)
  is especially relevant to strict functional effect programming and explicit
  elaboration to a smaller handler core.
- Bernardy et al.'s [Linear Haskell](https://arxiv.org/abs/1710.09756) shows how
  linear use can support pure interfaces to destructive implementation, though
  Blot currently keeps multiplicity outside ordinary function types.
- Weiss et al.'s [Oxide](https://arxiv.org/abs/1903.00982) is a warning that
  first-class borrowing requires a real provenance and lifetime model; Blot's
  initial lexical borrow is deliberately smaller.
- The [WebAssembly Core Specification](https://www.w3.org/TR/wasm-core/)
  supplies the target machine safety model. Blot's canonical adapters and ABI
  remain additional compiler obligations.

The novelty worth pursuing is the composition: a GPU-parseable surface, types as
phased values, algebraic subtyping, proof-carrying relationships outside the
type lattice, affine handlers, and ownership-directed Store reuse, all lowered
through one functional backend. The paper becomes credible when each boundary
has an explicit judgment and the implementation can emit the evidence the next
boundary consumes.

## 20. Working definition of Blot

Blot is a capability-safe, staged functional language in which:

- syntax is parsed deterministically under Baba's version-3 general frontend
  profile;
- dead pure declarations are absent and live ones evaluate once in source order;
- computations are sequenced explicitly with `<-`;
- types, effects, and layout descriptors are compile-time values with checked
  representations;
- ordinary types are inferred by algebraic subtyping;
- value relationships are proved in a separate refinement context;
- pattern matching is total unless the program writes an explicit trap;
- effects are generative capabilities handled by affine continuations;
- ownership is a separate structural usage judgment;
- immutable values may be updated destructively only under a uniqueness proof;
- specialization closes every representation before Runtime HIR validation; and
- WebAssembly exposes only the versioned canonical ABI, never private compiler
  values.

That is the theoretical target. The implementation can approach it in small,
reviewable changes, but every accepted shortcut should be named as a missing
proof rather than folded into the definition of the language.
