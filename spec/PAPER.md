# Blot: Semantic Model and Proof Obligations

## Status of this document

[`LANGUAGE.md`](../LANGUAGE.md) is the normative contract for accepted source and
its implemented meaning. This paper is the integrated semantic model: it explains
how Blot's source semantics, static judgments, staging rules, ownership analysis,
and compiler-correctness obligations fit together.

The focused specifications own exact rules in their domains:

- [`FRONTEND.md`](FRONTEND.md) owns parsing and elaboration;
- [`CORE_SEMANTICS.md`](CORE_SEMANTICS.md) owns demand, semantic identities,
  module instances, handlers, progress, and cancellation;
- [`TYPECHECKING.md`](TYPECHECKING.md) owns ordinary subtyping and inference;
- [`SAFETY.md`](SAFETY.md) owns coverage, relationships, ownership, and
  certificates;
- [`STAGING.md`](STAGING.md) owns compile-time evaluation and specialization;
- [`RUNTIME.md`](RUNTIME.md) owns Runtime HIR and the public ABI; and
- [`COMPILER.md`](COMPILER.md) and [`CORRECTNESS.md`](CORRECTNESS.md) own the
  pass graph and compiler theorem.

A duplicated rule in this paper is explanatory. If it conflicts with its focused
specification, the conflict is a specification defect; this paper does not
silently override the focused rule. Implementation status and migration work
belong in [`docs/roadmap.md`](../docs/roadmap.md) and the review notes under
[`docs/`](../docs/), not in the semantic model.

Nothing here claims that the entire language or compiler has been mechanized.
Named lemmas and theorems are obligations. Tests, certificate replay, and the
current Lean model are evidence only for the boundaries they actually encode.

## Abstract

Blot is a small staged functional language whose design keeps several analyses
separate:

- Baba supplies deterministic concrete syntax; Blot supplies elaboration and
  meaning;
- values are distinct from computations in Core;
- compile-time availability is distinct from run-time typing;
- principal ordinary types are distinct from relationships between particular
  values;
- ownership is a use judgment, not another subtype dimension;
- immutable source operations may reuse storage only after a separately checked
  uniqueness proof; and
- source type compatibility is distinct from physical representation and public
  ABI compatibility.

Types, effects, fixities, layouts, and reflection descriptors are ordinary
compile-time values interpreted through checked bridges. Ordinary inference uses
an algebraic-subtyping bound graph. Relationships such as an index being within
one particular array live in a separate proposition context. Algebraic effects
are generative capabilities with explicit handlers and one-shot continuations.
Staging erases compile-time-only values, specialization closes every residual
representation, and validated Runtime HIR lowers to Rust-generated WebAssembly.

The theory is a package of smaller claims rather than one use of the word
"sound": deterministic elaboration, phase separation, type-and-effect safety,
coverage, proof-required operation safety, ownership safety, staging adequacy,
representation closure, target simulation, and ABI adequacy.

## 1. Semantic commitments

Blot's central commitments are these:

1. **One source meaning.** Accepted source has one elaboration and one source
   observation model. Auxiliary evaluators may check it; they do not define a
   second language.
2. **Explicit computations.** Effectful work is represented as a computation and
   sequenced explicitly. A value that denotes a suspended computation is still a
   value until applied.
3. **Checked phase crossing.** A run-time dependency cannot be used to construct
   a compile-time type, effect, fixity, layout, or reflection decision.
4. **Separate fact domains.** Ordinary subtype constraints, relational
   propositions, ownership paths, and representation facts have different
   judgments and different evidence.
5. **Stable semantic identity.** Expression, binding, value, effect, seal,
   module-instance, Store, and revision identities are not interchangeable cache
   keys.
6. **Observational compilation.** Returns, external requests, specified traps,
   and demanded divergence must be preserved; successful return values alone are
   not an adequate compiler theorem.
7. **Closed representation before emission.** Runtime HIR contains no unresolved
   source polymorphism, open structural choice, compile-time value, or unchecked
   proof premise.

The model does **not** claim that every program terminates, that an empty effect
row implies totality, that every true relational fact is inferable, that current
linearity is a resource-finalization logic, or that arbitrary hostile host values
are valid Blot values. Divergence and specified traps are source behaviors.
Boundary adapters validate untrusted values before constructing source values.

## 2. Judgment and artifact stack

The semantic pipeline is:

```text
UTF-8 source
  -> Baba compact CST
  -> hygienic surface elaboration
  -> phased value/computation Core
  -> ordinary type-and-effect inference
  -> coverage, relationship, and ownership checking
  -> staging and specialization
  -> validated Runtime HIR
  -> closed public layout and canonical adapters
  -> WebAssembly
```

Write the principal artifacts schematically as:

```text
s parse-> cst elaborate-> e
  check-> e_typed
  safe-> e_certified
  stage-> e_residual
  specialize-> hir
  lower-> wasm
```

Each boundary owns facts that later boundaries consume:

| Boundary | Produced fact |
| --- | --- |
| source to CST | token, rule, field, span, and parse identity |
| CST to Core | scope, control target, evaluation order, and source origin |
| Core checking | ordinary type, effect row, coercion, and compile-time identity |
| safety analyses | coverage, relationship, ownership, and reuse certificates |
| staging | residual closure and proof that erased values are unavailable at run time |
| specialization | closed representation for every residual use |
| Runtime HIR validation | target-admissible operations and complete metadata |
| ABI closure | public layout, lifting, lowering, and ownership policy |
| emission | target program related to Runtime HIR |

A later pass may validate an earlier fact, but it may not reconstruct a different
fact from source spelling or incidental target layout. Recomputing an effect
identity, field set, ownership path, or proof premise creates a second semantic
judgment and therefore a new proof obligation.

## 3. Observations, demand, and evaluation order

### 3.1 Visible behavior

For a closed computation, finite visible outcomes are:

```text
Outcome ::= Return(v)
          | Request(ell, operation, argument, continuation)
          | Trap(specified-trap)
```

Divergence is not another current-state constructor. It is a maximal execution
containing infinitely many reduction steps. Internal allocation identities,
administrative reductions, inlining, and private target layout are not visible
unless the source or ABI explicitly exposes a related value.

A host interaction is compared as a protocol: related executions issue the same
effect identity, operation, and related argument; related host responses resume
related continuations. A target-only request, return, or trap is a compiler
error even when all successful source examples still agree.

### 3.2 Liveness-erased pure declarations

Blot makes dead-definition elimination part of source meaning for pure
bindings. After name resolution and surface elaboration, build the lexical
binding-dependency graph of a block. Starting from the block result and every
semantically forced declaration, walk resolved reads backwards to obtain:

```text
live(block, result) = L
```

A pure declaration outside `L` is absent from evaluation. Every retained pure
declaration evaluates exactly once in source order. This is neither call-by-name
nor first-use forcing: no run-time thunk is introduced.

The liveness input is fixed before optimization. An optimizer may not erase a
trap or divergence and then use the resulting absence as evidence that the
binding was dead. The required erasure lemma preserves every demanded return,
request, specified trap, and divergence.

A retained pure expression may still trap or diverge. Reordering therefore
requires an independent totality and dependency argument; an empty effect row is
not enough. Computations, handlers, and branches may not be crossed by a
reordering that changes whether an expression is demanded.

### 3.3 Explicit sequencing

Surface `x <- c` sequences a computation. In Core it is a bind:

```text
bind x <- c in rest
```

When the source right-hand side is a nullary effect value, elaboration first
applies it to unit. An already applied effectful expression is not applied a
second time. A pure `let` may bind a function or suspended computation value, but
it may not hide an effectful evaluation that should have been sequenced.

Function position precedes a strict argument. Record, tuple, array, and
constructor payloads evaluate in source order. A conditional evaluates only its
selected branch. A deferred parameter has one affine demand controlled by the
callee; known deferred applications are normalized into ordinary residual
control before Runtime HIR rather than introducing a general run-time thunk
representation.

## 4. Core language

The surface grammar has one expression category. The semantic Core separates
values and computations.

### 4.1 Explanatory syntax

```text
v ::= () | integer | text | lambda x. c | record | array | K v | sealed v

p ::= v | x | p.f | pure-primitive(p*)
    | if p then p else p
    | case p of ...
    | let x = p in p

c ::= return p
    | bind x <- c in c
    | apply p p
    | perform[ell, operation] p
    | handle ell c with h
    | if p then c else c
    | case p of K_i x_i => c_i
```

This is a semantic grammar, not a replacement parser. The implementation may use
administrative normal form, arenas, compiler-local control sums, or closure
indices when those artifacts are related to these forms.

### 4.2 Computation types

Write:

```text
Gamma |- p : A
Gamma |- c : A ! epsilon
```

for a value-producing pure term and a computation returning `A` while possibly
requesting labels in `epsilon`. A function type is written schematically as:

```text
A -> (B ! epsilon)
```

Application belongs to the pure fragment only when the final row is empty and
the application itself has no other computation boundary. Otherwise it is a
Core computation and must be sequenced or returned as one.

Effect rows account for effect requests. They do not claim termination and do
not encode specified arithmetic, panic, representation, or host-contract traps.
Those are classified by the operational semantics.

### 4.3 Elaboration obligations

Surface elaboration must be hygienic: compiler-generated binders are identities
outside the source identifier space. Every generated node retains a source
origin sufficient for diagnostics.

The principal obligations are:

```text
Gamma |-surface s : A ! epsilon
--------------------------------  typing preservation
Gamma |-core elaborate(s) : A ! epsilon
```

and an operational correspondence up to administrative Core steps. Surface
forms such as loops, statement control, early return, handler composition, and
explicit `do` scopes do not receive independent downstream semantics when Core
already represents their behavior.

## 5. Phases and compile-time values

### 5.1 Availability is not typing

"Types are values" means that type expressions use the ordinary source syntax
and compile-time evaluator. It does not mean `Type : Type`, nor that every
compile-time value denotes a type.

Use separate judgments:

```text
Delta ; I |-ct e downarrow w ; I'     compile-time evaluation
Gamma |-rt e : A ! epsilon            run-time typing
```

`Delta` contains only compile-time-available bindings. `I` is the compiler-owned
identity/input world needed to make allocation and resolved file inputs stable.
A run-time binding cannot occur free in a compile-time type, effect, fixity,
layout, declaration tag, or reflection decision.

Source and host effects are unavailable during compile-time evaluation.
Dependency-resolved imports and included bytes are explicit compiler inputs,
recorded in the revision identity; they are not ambient run-time authority.

### 5.2 Checked bridges

Compile-time values are interpreted at specific boundaries through partial,
checked bridges:

```text
bridgeType   : CTValue -> Result<CoreType, Diagnostic>
bridgeEffect : CTValue -> Result<EffectDescriptor, Diagnostic>
bridgeLayout : CTValue -> Result<LayoutDescriptor, Diagnostic>
```

A closure that can compute a type is not itself a type; it must be applied at
compile time. Literal integers, records, constructor values, and arrays may have
well-defined type-denoting interpretations, but only `bridgeType` grants that
interpretation.

A decoder may deliberately attach a sound widened type to a concrete
compile-time value. Such a result is evidence `(w, A, proof that w inhabits A)`,
not an unchecked annotation and not a second run-time value.

### 5.3 Generative effects and applicative seals

An ordinary effect declaration allocates a generative atom under the complete
semantic identity of its evaluation:

```text
newEffect(module-instance, source-node, compile-time-scope, signature)
  = effect(ell, signature)
```

Repeating an administrative compiler read of the same declaration recovers the
recorded `ell`. Evaluating the declaration in a different module instance mints
a distinct atom even when the operation signatures are structurally equal.

A seal is applicative. Its identity is the pair:

```text
(public-name, canonical closed carrier)
```

Carrier equality is structural modulo alpha-renaming and the closed-type
normalization owned by `TYPECHECKING.md`; presentation text and map insertion
order are irrelevant. The carrier is invariant. There is no subtyping relation
between different public names, or between equal names with inequivalent
carriers. A future fresh abstraction capability would be a different generative
primitive, not a reinterpretation of `seal`.

## 6. Modules and semantic identity

A resolved module definition, a written import occurrence, and an evaluated
module instance are different objects:

```text
ModuleDef(m)
ImportSite(parent-instance, importer-revision, source-site, m) = o
ModuleInstance(parent-stack ++ [o]) = iota
```

`import "specifier"` instantiates the resolved module with unit.
`import "specifier" with value` supplies the explicit argument. The instance's
top-level declarations evaluate once in source order and the import expression
produces the returned value. Import does **not** expose an uninvoked module
closure as a source value.

Aliasing, projecting, or returning one import result shares that result and does
not replay initialization. A second written import occurrence denotes a second
instance even when its specifier and argument are equal. The same nested import
site under two parent instances also denotes two instances because the complete
parent stack differs.

Inlining may erase a module shell but must preserve instance identity and
observations. A reusable result cache is valid only under the complete module
instance identity and source revision. A definition path alone is not a valid
key for a result that may contain generative effects, seals built from local
inputs, closures, traps, divergence, or other instance-dependent values.

The same discipline applies across the compiler. Source-expression identity,
binding identity, immutable value identity, effect atom identity, seal identity,
module-definition identity, import occurrence, module instance, Store/root
identity, and revision identity have different allocation and lifetime rules.
`CORE_SEMANTICS.md` owns the complete table.

## 7. Ordinary types and inference

### 7.1 Type algebra

The explanatory ordinary type language includes:

```text
A, B ::=
    bottom | top | unit
  | range(domain, lower, upper)
  | A ->{epsilon} B
  | { field_i : A_i }
  | Array A
  | < Constructor_i : A_i >
  | finite-ground-union(A_i)
  | forall a. A
  | Seal(name, carrier)
  | Opaque(identity)
```

Open inference uses a Simple-sub-style graph of lower and upper bounds. Exact
ground intersections and differences may be normalized after a type is closed;
the theory does not assume arbitrary Boolean negation or intersection inside the
open inference graph.

Predicative `forall` is checked by left instantiation and right skolemization. An
inference variable is not solved with a polymorphic type. Predicate-defined
integer types normalize at compile time into ranges and finite ground unions
already present in the algebra; predicates do not become a new solver node.

### 7.2 Representative subtyping rules

```text
bottom <= A                         A <= top

C <= A    B <= D    epsilon <= epsilon'
------------------------------------------------ function
(A ->{epsilon} B) <= (C ->{epsilon'} D)

required fields are present and depth-compatible
------------------------------------------------ record
wider record <= narrower record

cases(L) subset cases(R), with compatible payloads
-------------------------------------------------- variant
L <= R

labels(epsilon) subset labels(epsilon')
--------------------------------------- effects
epsilon <= epsilon'

A <= B
---------------- array
Array A <= Array B
```

Arrays are covariant because source arrays are immutable. An ownership-approved
destructive implementation of a persistent update does not make source aliases
mutable. If externally mutable references are introduced, their element
variance requires a new rule.

Seals compare only when both their public names and canonical carriers agree;
the carrier is invariant. They do not contain a generative effect atom.

### 7.3 Scope of principality

The intended principal-inference theorem is deliberately narrow:

> For the rank-1 open algebraic core, after compile-time expressions required by
> checking have normalized, settling a successful bound graph returns a
> principal ordinary type modulo alpha-renaming and the specified type
> equivalence.

Rank-N subsumption, checked reflection, ground union choice, omitted unit fields,
predicate requirements, relational proofs, and ownership are additional checked
boundaries. They must be sound, but they are not smuggled into the rank-1
principality claim.

A successful algorithmic result must satisfy the declarative relation. A
conservative refusal may lose completeness while preserving soundness. Assigning
an unconstrained variable where no premise exists loses soundness.

### 7.4 Coercions and representation

A signature is checked by subsumption and becomes the binding's published type.
A subtype use that changes representation records an explicit typed-Core
coercion or specialization fact. Structural source compatibility does not grant
permission to guess a target nominal shape from the fields one function happens
to read.

Field names for structural records are compile-time labels. A genuinely run-time
key uses a homogeneous dictionary or another explicitly dynamic structure; an
unconstrained type variable is not an encoding of dynamic field access.

## 8. Coverage and relationships

### 8.1 Relationships are not ordinary types

The checker carries a proposition context beside the type environment:

```text
Gamma ; Phi |- e : A ! epsilon
```

`Phi` refers to stable immutable value identities and may contain supported
facts such as:

```text
x = y
x = y + k
0 <= i

i < length(alpha)
length(beta) = length(alpha) + k
InBounds(alpha, i)
```

An alias preserves a value identity. A new construction or identity-changing
rebind creates a new one. A persistent array update may create a new value
identity while recording the length relation it preserves.

The first solver is intentionally incomplete and decidable. Failure to prove a
fact does not make it approximately true; it means the program must use a total
operation or be rejected at a proof-required operation.

### 8.2 Total and proof-required operations

A total array read returns an optional result after one semantic bounds decision.
A direct read has a proof premise:

```text
Gamma ; Phi |- a : Array A
Gamma ; Phi |- i : Int
Phi entails 0 <= i < length(identity(a))
------------------------------------------------
Gamma ; Phi |- get_proved(a, i) : A
```

The certificate names the saturated operation and every stable premise identity.
Lowering may omit a target bounds branch only after independently replaying that
certificate. Copying the certificate to another expression or using it after an
identity-changing rebind is invalid.

Proof-producing iterators may expose erased relationship packages to a loop
body. The source sees ordinary values; the checker receives propositions tied to
the exact collection identity. A name such as `indexed` is not magical: the
relationship follows a checked primitive or function summary.

### 8.3 Coverage

An accepted closed match is statically exhaustive or has an irrefutable arm.
Coverage operates on the complete cross-product of pattern columns. A guard
covers only the subset justified by a representable proved proposition.
Unlistable or open domains require a catch-all.

The safety statement is:

```text
Gamma |- v : A    covers(A, arms)
----------------------------------
some arm matches v
```

An explicit panic in a catch-all is a specified program trap, not a latent
missing-match state.

## 9. Effects, handlers, and continuations

### 9.1 Effect requests

Let an effect atom `ell` index an operation signature:

```text
Signature(ell, operation) = A -> B
```

Then:

```text
Gamma |- v : A
--------------------------------------------- perform
Gamma |- perform[ell, operation](v) : B ! {ell}
```

Labels are compile-time capabilities. Structural equality of operation
signatures does not identify ordinary source effects.

### 9.2 Handler reduction

A handler has operation clauses and an optional return clause. When a request for
the handled atom occurs in the delimited evaluation context `E`:

```text
handle ell (E[perform[ell, operation](v)]) with h
  --> h.operation(v, resume)

resume = one-shot (lambda b.
  handle ell (E[return b]) with h)
```

A successful resume re-enters the handler around the captured continuation.
The handler clause itself is not recursively enclosed by the same handler.
Therefore a clause that performs `ell` again emits a new request; the effect is
reintroduced rather than silently swallowed.

The result row is defined by subtraction, not by a non-unique union
factorization:

```text
Gamma |- c : A ! epsilon_c
Gamma |- h : Handler(ell, A, B, epsilon_h)
----------------------------------------------------------- handle
Gamma |- handle ell c with h
  : B ! ((epsilon_c \ {ell}) union epsilon_h)
```

`epsilon_h` includes effects of operation clauses and the return clause. Handling
an atom absent from `epsilon_c` is valid: operation clauses are unreachable for
that computation, while a return clause may still transform the result.

### 9.3 One-shot use and cancellation

A captured continuation is used at most once. Ownership determines whether its
binding is affine or linear:

- affine means it may be resumed or cancelled zero or one time; and
- linear means exactly one consuming action is required on every terminating
  exit from the clause.

`Continuation.cancel` is an explicit sequenced consuming action. It spends the
continuation without entering the captured evaluation context. It is not a pure
`let`-erasable operation and it cannot be forged for an arbitrary closure.

Current linearity is a **unique-use discipline**, not a theorem that every
captured host resource has run an observable finalizer. Cancelling a continuation
accounts for its structural ownership obligation but does not execute consumers
inside the discarded continuation. A future must-finalize resource class must
therefore add an explicit finalization protocol, cancellation certificate, or
must-resume restriction. Merely labeling a value linear is not sufficient.

A defensive run-time spent flag may remain, but accepted source must not depend
on it to reject a second resume.

### 9.4 Host effects

Ordinary source effects must be handled before the closed module boundary. An
explicit host capability may remain and lower to a typed import. The entry module
input and explicitly supplied host capabilities are the complete ambient
authority.

A host may diverge, trap, or violate its boundary contract. Canonical adapters
validate representational claims before an invalid value enters Blot's interior
semantics.

## 10. Ownership, borrowing, and reuse

### 10.1 Usage judgment

Ownership is checked after ordinary typing and relationship checking:

```text
Gamma ; Phi ; Omega |- e : A ! epsilon => Omega'
```

`Omega` maps stable binding paths to use obligations:

```text
U  unrestricted: any number of uses
A  affine: at most one consuming use
L  linear: exactly one consuming use on every terminating exit
B  borrowed: inspection only, with no move or escape
```

These are not subtype constructors. Erasing `Omega` does not change the ordinary
principal type.

A consuming destructor, including continuation cancellation where permitted,
accounts for the consumed structural value. That statement guarantees use
coherence; it does not imply domain-specific cleanup unless the consuming
operation's own contract specifies cleanup.

### 10.2 Structural ownership

Closures own captured environments. Records, variants, tuples, arrays, and other
aggregates carry the joined obligations of their contents. Moving a container
moves its owned paths. Projecting one owned field is valid only when omitted
siblings are unrestricted or a consuming split accounts for every owned output.

Branches start with the same input ownership state. Continuing branch outputs
must agree for linear paths, while affine joins remain conservative. Recursive
ownership requires a checked call-count or transfer argument; source traversal
order is not such a proof.

A function carries an erased ownership summary describing how it uses each
parameter and callback. The caller checks an argument against that summary.
Passing a linear closure once to a function that invokes it twice is still a
duplication and must be rejected.

### 10.3 Borrows

The minimal borrow is a lexical, non-storable view. It may be used for immediate
projection or passed to a borrowing parameter. It may not be returned, retained
in an aggregate, captured by an escaping closure, moved, or passed across the
host boundary.

First-class references or slices would require an explicit provenance and region
calculus. They are not obtained by informally extending the lexical borrow
marker.

### 10.4 Destructive reuse

Source arrays and records remain immutable. A target may reuse storage only when
a certificate proves that no source-observable alias can be used afterward and
that every consumed structural path is accounted for.

Schematically:

```text
unique consuming use of a at persistent_update(a, ...)
required relationship proofs hold
------------------------------------------------------
target Store mutation is permitted
```

The target mutation must simulate a fresh persistent source result. Syntactic
last occurrence is not a uniqueness proof: closures, branches, recursion, and
returned aliases can all invalidate it.

## 11. Staging, specialization, and the ABI

### 11.1 Phase erasure

After staging, residual run-time code is closed over compile-time bindings.
Every erased type representation, effect descriptor, fixity, reflection value,
layout, declaration tag, and included-data computation has already been consumed
into residual code or checked metadata.

The phase-safety obligation is contextual: replacing an erased compile-time value
while holding its generated residual artifact fixed cannot change run-time
behavior. A compile-time computation that does not terminate is a build that
does not terminate unless the implementation applies a documented fuel policy;
fuel exhaustion is a compiler diagnostic, not a source value.

### 11.2 Representation closure

Structural source types do not determine one physical representation. Before
Runtime HIR, specialization must:

- instantiate residual polymorphism;
- close record and variant shapes;
- insert or discharge representation-changing coercions;
- specialize handlers and known higher-order choices;
- erase compile-time and proof-only values; and
- attach ownership permissions to Store operations.

A Runtime-HIR validation failure caused only by unresolved representation for a
closed accepted source program is a compiler bug. An explicitly unsupported
public ABI type or experimental target may be refused at its stated boundary; it
must not be disguised as a source type error.

### 11.3 Public ABI

Only ABI-admissible closed types receive public lifting and lowering functions:

```text
lift_A  : caller representation -> Result<source A, boundary trap>
lower_A : source A -> caller representation plus ownership obligation
```

For every valid public value:

```text
lift_A(lower_A(v)) ~= v
```

where `~=` ignores private allocation identity and respects canonical ordering.
Malformed UTF-8, booleans, discriminants, lengths, pointers, alignments, and
ownership state trap before an invalid source value is constructed.

Private target tags, Store headers, roots, object addresses, and closure tables
are not source observations and do not cross the public boundary unless a future
ABI version specifies them.

## 12. The theorem package

### 12.1 Parsing and elaboration

- **Token and parse determinism.** Every accepted source has the token and compact
  CST identity required by elaboration.
- **Elaboration totality on accepted CST.** Every accepted compact CST either
  elaborates or produces a source diagnostic; compiler-local failure is not a
  source outcome.
- **Elaboration preservation and simulation.** Scope, control targets,
  evaluation order, type, effect row, and observations are preserved up to
  administrative Core steps.

### 12.2 Source type and effect safety

Preservation is stated over a configuration world that may extend with fresh
immutable identities, continuation state, and other semantically allocated
objects:

```text
W ; Gamma ; Phi |- c : A ! epsilon
c -> c'
------------------------------------------------ preservation
exists W' >= W, Gamma', Phi'.
  W' ; Gamma' ; Phi' |- c' : A ! epsilon
```

The extensions must respect stable identity and ownership invariants. Reduction
cannot change the promised result type or introduce an unaccounted effect label.

One-step progress for a closed well-typed computation says it is one of:

- a return;
- able to take a reduction step;
- an unhandled request whose label is in its row; or
- a specified language trap.

Divergence is intentionally absent from that list. The separate
maximal-execution theorem says that every maximal execution reaches a classified
finite outcome or contains infinitely many reduction steps. No accepted program
gets stuck on a missing case, forged proof, invalid internal field, second
continuation use, or unclassified machine state.

### 12.3 Safety analyses

- **Coverage safety.** An accepted closed match does not reach a missing arm.
- **Relationship safety.** Every proof-required operation satisfies the
  proposition named by its replayed certificate.
- **Ownership safety.** No tracked path is moved twice, moved through a borrow,
  or left unaccounted on a terminating exit; affine and linear usage bounds are
  respected.
- **Reuse adequacy.** Every permitted target mutation is observationally related
  to the persistent source operation it implements.

These statements do not imply that current linearity runs resource finalizers.
That requires a separate resource protocol.

### 12.4 Staging and compiler correctness

For a pass relation `R_i`, finite source steps may be matched by zero or more
target administrative steps:

```text
R_i(x, y)    x -> x'
-------------------------------
exists y'. y ->* y' and R_i(x', y')
```

This weak forward-simulation clause alone is insufficient: an infinite source
execution could otherwise be "matched" by a target that stutters forever in one
state. Every pass must additionally provide progress-sensitive adequacy:

1. an empty target match strictly decreases a well-founded stuttering rank;
2. a related source return, request, or trap reaches the matching target outcome
   after finitely many administrative steps;
3. every target return, request, or trap is reflected by the source; and
4. related request/response protocols resume related continuations.

A progress-sensitive weak bisimulation is an equivalent proof shape. Composition
of these relations yields the whole-compiler theorem: for a closed program and
related host responses, source evaluation and emitted WebAssembly have the same
returns, requests, specified traps, and divergence. Target restrictions and ABI
validation are included at their explicit boundaries.

## 13. Evidence and trusted boundaries

Executable examples are specification fixtures, not proofs. Generated tests,
mutation tests, differential evaluation, certificate replay, Runtime-HIR
validation, Wasm validation, and ABI round trips each address different failure
classes.

A certificate checker reduces trust only when it is smaller than the producer,
reconstructs all premises from stable identities, and rejects evidence copied to
a different expression or revision. A complicated analysis may remain outside a
mechanized core through translation validation; its evidence may not become an
axiom merely because the producer is deterministic.

The current Lean development is an initial model of selected Core boundaries.
Its logical assurance and its correspondence to production artifacts are
separate claims. A theorem about a seed calculus does not establish parser,
module, reflection, SIMD, specialization, or ABI correctness until a checked
translation connects those artifacts.

## 14. Deliberately open extensions

The following choices can remain open without making the existing model
ambiguous:

- whether must-finalize resources use explicit finalizers, cancellation evidence,
  or a must-resume continuation restriction;
- whether first-class borrows introduce regions, provenances, or a restricted
  path calculus;
- whether the relationship solver grows beyond its decidable affine fragment;
- whether full-width words become intrinsic domains or sealed library values with
  compiler operations;
- whether specialization clones functions, passes representation dictionaries,
  or combines both; and
- which stable Core and artifact-correspondence theorem is mechanized next.

Each extension must preserve the existing interfaces: ordinary subtype
inference, proposition entailment, ownership checking, phase erasure,
representation validation, and progress-sensitive target simulation.

## 15. Research context

Blot composes existing ideas but does not inherit their theorems by citation.
The main influences are:

- Parreaux's [The Simple Essence of Algebraic
  Subtyping](https://cse.hkust.edu.hk/~parreaux/publication/icfp20/) for
  lower/upper-bound inference and compact principal types;
- Levy's [call-by-push-value](https://link.springer.com/book/10.1007/978-94-007-0954-6)
  for an explicit value/computation distinction;
- Bauer and Pretnar's [Programming with Algebraic Effects and
  Handlers](https://arxiv.org/abs/1203.1539) and core Eff effect system for
  operation-and-handler safety;
- Lindley, McBride, and McLaughlin's
  [Frank](https://arxiv.org/pdf/1611.09259) for strict effect programming and
  elaboration to a smaller handler core;
- Bernardy et al.'s [Linear
  Haskell](https://arxiv.org/abs/1710.09756) for pure interfaces backed by
  controlled destructive implementation;
- Weiss et al.'s [Oxide](https://arxiv.org/abs/1903.00982) as evidence that
  escaping references require a real provenance model; and
- the [WebAssembly Core Specification](https://www.w3.org/TR/wasm-core/) for the
  target machine's validation and execution model.

Blot's research claim is the composition and the explicit boundaries: a
GPU-profile surface, compile-time type values, algebraic subtyping, relational
proofs outside the type lattice, algebraic effects, structural ownership, and
representation-closed WebAssembly through one semantic compiler.

## 16. Working definition

Blot is a capability-safe staged functional language in which:

- source syntax is accepted deterministically under Baba's checked frontend
  profile;
- dead pure declarations are absent and retained declarations evaluate once in
  source order;
- computations are sequenced explicitly;
- types, effects, fixities, and layouts are compile-time values interpreted by
  checked bridges;
- ordinary types are inferred by a bounded algebraic-subtyping judgment;
- relationships between particular values are proved separately;
- closed matches are exhaustive unless the program writes an explicit trap;
- effects are generative capabilities with subtraction-based handler rows and
  one-shot continuations;
- current linearity is structural unique use, while must-finalize resources
  require an additional protocol;
- immutable source values may reuse target storage only under independently
  replayed ownership evidence;
- each written import occurrence owns one module instance identity;
- specialization closes representation before Runtime HIR; and
- the public WebAssembly boundary exposes only versioned canonical values, never
  compiler-private representations.

That is the coherent target. An implementation shortcut is acceptable only when
its missing proof or unsupported boundary is named explicitly; it does not
silently redefine the language.