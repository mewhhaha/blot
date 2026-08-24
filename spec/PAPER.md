# Blot: Semantic Model and Proof Obligations

## Status of this document

This paper is the integrated semantic model. It explains how Blot's source
semantics, static judgments, staging rules, ownership analysis, representation
closure, and compiler-correctness obligations fit together.

The authority order is defined by [`README.md`](README.md). In particular:

- [`grammar.baba`](../grammar.baba) decides concrete parse acceptance;
- [`COHERENCE.md`](COHERENCE.md) owns cross-document invariants and corrections;
- [`LANGUAGE.md`](../LANGUAGE.md) owns the remaining source behavior;
- focused specifications own exact judgments in their domains; and
- this paper composes those judgments rather than creating another semantics.

Nothing here claims that the whole language or compiler has been mechanized.
Named lemmas and theorems are obligations. Tests, certificate replay, the Rust
and Node evaluators, Runtime-HIR validation, Wasm validation, and the current
Lean model are evidence only for the boundaries they actually encode.

## Abstract

Blot is a small staged functional language with explicit effect sequencing,
algebraic-subtyping inference, relational safety proofs outside the ordinary
type lattice, generative algebraic effects, structural ownership, specialization
to closed Runtime HIR, and a versioned WebAssembly boundary.

The design separates questions that are often conflated:

- parsing from elaboration;
- values from computations;
- an empty effect row from termination or absence of traps;
- compile-time availability from run-time typing;
- ordinary subtyping from propositions about particular immutable values;
- source immutability from target storage reuse;
- structural use accounting from resource finalization;
- source compatibility from physical representation and ABI compatibility; and
- semantic source rejection from compiler resource limits or target-policy
  refusal.

Types, effect descriptors, layouts, and reflection descriptors are ordinary
compile-time values interpreted through checked bridges. Operator spelling and
fixity instead come from one generated language plan. Every application is a
Core computation, even when its effect row is empty. Effects are generative
capabilities; seals are applicative nominal identities. Ownership is a separate
mode-indexed use judgment. Staging erases compile-time-only values,
specialization closes every residual representation, and validated Runtime HIR
lowers to WebAssembly under a progress-sensitive observational theorem.

## 1. Semantic commitments

Blot makes these commitments:

1. **One accepted-source meaning.** A parsed source program has one hygienic
   elaboration and one observation model. An auxiliary evaluator may validate
   that meaning but cannot define a second language.
2. **One application schedule.** Function application is always a Core
   computation. An empty row excludes algebraic-effect requests; it does not
   create a pure-call semantics, prove termination, or remove specified traps.
3. **Explicit statement values.** Declarations and statement control appear in a
   value only through `do:` or `compdo:`. Indentation alone is continuation
   layout, not an anonymous block constructor.
4. **Checked phase crossing.** Run-time data cannot determine a compile-time
   type, effect descriptor, layout, declaration tag, or reflection decision.
5. **Separate fact domains.** Ordinary subtype bounds, relational propositions,
   ownership paths, and representation facts have different judgments and
   evidence.
6. **Stable semantic identity.** Expression, binding, immutable-value, effect,
   seal, module-instance, Store/root, and revision identities are not
   interchangeable cache keys.
7. **Closed representation before emission.** Runtime HIR contains no unresolved
   source polymorphism, open structural representation choice, compile-time
   value, live proof object, or unchecked operation premise.
8. **Observational compilation.** Returns, host requests, specified traps, and
   demanded divergence are preserved and reflected. Agreement only on successful
   examples is insufficient.
9. **Classified failure.** Source invalidity, deterministic compiler limits,
   unsupported target policy, and compiler invariant failure are distinct
   meanings.

The model does not claim that every program terminates, that every true relation
is inferable, that current linearity runs finalizers, that raw hostile host
values are Blot values, or that every well-typed structural carrier satisfies a
library-level abstraction invariant.

## 2. Artifact and judgment stack

The semantic pipeline is:

```text
UTF-8 source
  -> Baba token stream and compact CST
  -> hygienic surface elaboration
  -> demanded value/computation Core
  -> ordinary type-and-effect inference
  -> coverage, relationship, and ownership checking
  -> compile-time evaluation and residualization
  -> representation-closing specialization
  -> validated Runtime HIR
  -> canonical public adapters
  -> WebAssembly
```

Schematic artifacts are:

```text
s parse-> cst elaborate-> c
  demand-> c_live
  type-> c_typed
  safe-> c_certified
  stage-> c_residual
  specialize-> hir
  abi/lower-> wasm
```

Each boundary owns facts that later passes may validate and consume:

| Boundary               | Produced fact                                                      |
| ---------------------- | ------------------------------------------------------------------ |
| source to CST          | token, rule, field, span, and parse identity                       |
| CST to Core            | scope, explicit-block target, evaluation order, and source origin  |
| demand                 | exact live binding graph and forced declarations                   |
| ordinary checking      | type, effect row, coercion, and compile-time identity              |
| safety checking        | coverage, relationship, ownership, and reuse certificates          |
| staging                | phase erasure and residual closure                                 |
| specialization         | one closed representation at every residual use                    |
| Runtime-HIR validation | target-admissible operations and complete metadata                 |
| ABI closure            | public layout, validation, lifting, lowering, and ownership policy |
| emission               | target program related to validated Runtime HIR                    |

A later pass may replay an earlier fact; it may not reconstruct a different fact
from source spelling or incidental target layout. Recomputing an effect
identity, field set, ownership path, proof premise, or public layout creates
another judgment and another proof obligation.

## 3. Observations, demand, and order

### 3.1 Visible behavior

For a closed computation, finite visible outcomes are:

```text
Outcome ::= Return(v)
          | Request(ell, operation, argument, continuation-protocol)
          | Trap(specified-trap)
```

Divergence is a maximal execution containing infinitely many reduction steps; it
is not another one-step machine constructor. Administrative reductions, private
allocation identities, inlining, closure tables, Store headers, and target-local
layout are not observations unless the source or ABI explicitly exposes a
related value.

A host interaction is compared as a protocol. Related executions issue the same
effect identity and operation with related arguments. Related host responses
resume related one-shot continuations. Raw continuation pointers or target
addresses are not compared.

### 3.2 Lexical demand

Blot makes dead pure declarations absent from source evaluation. After name
resolution and surface elaboration, a block's lexical dependency graph is walked
backwards from its result and every semantically forced declaration:

```text
live(block, result) = L
```

A pure declaration outside `L` is absent. Every retained pure declaration is
evaluated exactly once in source order. This is neither call-by-name nor
first-use forcing: no run-time thunk is introduced.

The liveness input is fixed before optimization. An optimizer cannot erase a
trap or divergence and then use its absence as evidence that the binding was
dead. The erasure lemma preserves every demanded return, request, specified
trap, and divergence.

Ownership is checked over the demanded program. A consuming operation occurring
only in an erased declaration is absent and cannot discharge a linear
obligation. Intentional consuming discard must be sequenced or otherwise appear
in the demanded result.

A retained empty-row computation may still trap or diverge. Reordering therefore
requires an independent totality and dependency proof. Effect emptiness alone is
not permission to cross a branch, handler, or demand boundary.

### 3.3 Source evaluation order

Function position is evaluated before a strict argument. Record, tuple, array,
and constructor payloads evaluate in source order. A conditional evaluates only
the selected branch. A deferred argument has one affine demand controlled by the
callee; known deferred applications specialize to ordinary residual control and
do not introduce a general run-time thunk representation.

Surface `x <- c` is explicit sequencing. A suspended nullary effect value is
applied to unit exactly once; an already applied computation is not applied
again.

## 4. Core values and computations

The semantic Core has values and computations:

```text
Gamma |- v : A
Gamma |- c : A ! epsilon
```

A value may be a scalar, aggregate, constructor, closure, seal value, or other
already formed immutable object. A computation returns a value of type `A` and
may request labels in `epsilon`.

Representative forms are:

```text
c ::= return v
    | let-value x = v in c
    | bind x <- c in c
    | apply v v
    | perform[ell, operation] v
    | handle ell c with h
    | if v then c else c
    | case v of K_i x_i => c_i
    | primitive(v*)
```

An implementation may use ANF, arenas, control sums, closure indices, or
administrative nodes when a checked relation connects those artifacts to this
model.

### 4.1 Application

Application has one rule:

```text
Gamma |- f : A ->{epsilon} B
Gamma |- a : A
--------------------------------
Gamma |- apply f a : B ! epsilon
```

Every application is a computation. When `epsilon` is empty, the call issues no
algebraic-effect request, but it may still return, trap, or diverge. A surface
pure position admits the call only after the row settles empty and elaborates
its returned value through this same computation schedule. A non-empty row
requires sequencing or a computation-returning context.

### 4.2 Effect rows and traps

Effect rows account for algebraic-effect requests. They do not encode
termination, arithmetic traps, explicit panic, representation checks, malformed
host inputs, or compiler failures. Those are classified by the operational, ABI,
or compiler judgments that own them.

### 4.3 Elaboration

Surface elaboration is hygienic: generated binders occupy identities outside the
source identifier space, and generated nodes retain source origins for
diagnostics.

Its obligations are typing preservation and operational correspondence up to
administrative Core steps. Loops, rebinding, statement control, early return,
explicit blocks, handler composition, and deferred calls receive one downstream
meaning through their Core elaboration.

## 5. Phases and compile-time values

### 5.1 Availability is not typing

"Types are values" means type expressions use ordinary source syntax and the
compile-time evaluator. It does not imply `Type : Type`, and not every
compile-time value denotes a type.

Use separate judgments:

```text
Delta ; I |-ct e downarrow w ; I'     compile-time evaluation
Gamma |-rt c : A ! epsilon            run-time computation typing
```

`Delta` contains only compile-time-available bindings. `I` is the
compiler-controlled identity and explicit-input world. A run-time binding cannot
occur free in a compile-time type, effect descriptor, layout, tag, or reflection
decision.

Source and host effects are unavailable during compile-time evaluation. Resolved
imports and included bytes are explicit compiler inputs recorded in the revision
identity; they are not ambient run-time authority.

Operator spelling and grouping are not compile-time values. They come from the
generated language plan and are fixed before source elaboration.

### 5.2 Checked bridges

Specific boundaries interpret compile-time values through partial checked
bridges:

```text
bridgeType   : CTValue -> Result<CoreType, SourceDiagnostic>
bridgeEffect : CTValue -> Result<EffectDescriptor, SourceDiagnostic>
bridgeLayout : CTValue -> Result<LayoutDescriptor, SourceDiagnostic>
```

A closure capable of computing a type is not itself a type; it must be applied
at compile time. A decoder may attach a sound widened type to a concrete value,
but the result is evidence `(w, A, proof w inhabits A)`, not an unchecked
annotation or a second run-time value.

### 5.3 Compiler limits

A compile-time computation may diverge in the source semantics. An
implementation may stop first at a documented deterministic resource limit.
`BLOT_EVALUATION_LIMIT` is a `LimitDiagnostic`: it establishes no source
acceptance or rejection and is not a source observation. Raising the limit may
allow the same revision to finish without changing language meaning.

## 6. Modules and semantic identity

A resolved module definition, a written import occurrence, and an evaluated
module instance are distinct:

```text
ModuleDef(m)
ImportSite(parent-instance, importer-revision, source-site, m) = o
ModuleInstance(parent-stack ++ [o]) = iota
```

Bare `import` supplies unit. `import ... with value` supplies the explicit
argument. The instance's top-level declarations evaluate once in source order,
and the import expression yields the instance result. Import does not expose an
uninvoked module closure as a source value.

Aliasing, projecting, or returning one import result shares it. A second written
import occurrence denotes another instance even when the specifier and argument
are equal. The same nested site under two parent instances is distinct because
the complete parent stack differs.

Inlining may erase a module shell but must preserve instance identity and
observations. A result cache is valid only under the complete module-instance
identity and source revision. A definition path alone cannot key a result that
may contain generative effects, closures, traps, divergence, or other
instance-dependent values.

Identity classes include source expression, binding, immutable value, effect
atom, seal, module definition, import occurrence, module instance, Store/root,
and revision. Equality in one class does not imply equality in another.

## 7. Generative effects and applicative seals

### 7.1 Effects

An ordinary effect declaration allocates under its complete semantic occurrence:

```text
newEffect(module-instance, source-node, compile-time-scope, signature)
  = effect(ell, signature)
```

Administrative re-evaluation of the same recorded occurrence recovers `ell`.
Evaluation in another module-instance stack mints a fresh atom. Aliasing
preserves the atom; structural operation-signature equality does not identify
effects.

### 7.2 Seals

A seal is applicative. Its identity is:

```text
(public-name, canonical closed invariant carrier)
```

Carrier equality is structural modulo alpha-renaming and the closed-type
normalization owned by `TYPECHECKING.md`. Presentation text and map insertion
order are irrelevant. The carrier is invariant. Different names, or equal names
with inequivalent carriers, do not subtype each other.

A future fresh abstraction capability would be another generative primitive; it
would not reinterpret `seal`.

## 8. Ordinary types and inference

The explanatory ordinary type algebra includes:

```text
A, B ::=
    bottom | top | unit
  | integer-range(domain, lower, upper)
  | A ->{epsilon} B
  | { field_i : A_i }
  | Array A
  | < Constructor_i : A_i >
  | finite-ground-union(A_i)
  | forall a. A
  | Seal(name, carrier)
  | Opaque(identity)
```

Open inference uses an algebraic-subtyping graph of lower and upper bounds.
Exact ground intersection and difference normalize only after the relevant type
is closed; arbitrary Boolean negation is not introduced into the open graph.

Predicative `forall` is checked by left instantiation and right skolemization.
An inference variable is not solved with a polymorphic type. Predicate-defined
integer types normalize at compile time into existing ranges and finite ground
unions.

Representative subtyping principles are:

- `bottom <= A <= top`;
- function inputs are contravariant, outputs covariant, and rows covariant;
- records use width and depth subtyping;
- variant constructor sets are covariant by inclusion;
- effect rows are covariant by label inclusion;
- immutable arrays are covariant in their element type; and
- seals compare only when public name and canonical invariant carrier agree.

Array covariance follows source immutability. Ownership-approved destructive
reuse does not make source aliases mutable. Externally mutable references would
need another variance rule.

The principal-inference claim is deliberately limited: after required
compile-time normalization, the successful rank-1 open algebraic core has a
principal ordinary type modulo alpha-renaming and specified equivalence. Rank-N
subsumption, checked reflection, closed ground operations, predicate
requirements, relationships, ownership, and representation closure are separate
sound boundaries rather than hidden parts of that principality theorem.

Subtyping that changes representation records an explicit coercion or
specialization fact. Structural source compatibility does not authorize a target
shape guessed from the fields one function happens to read.

## 9. Coverage and relationships

### 9.1 Proposition context

Relationships between particular immutable values live beside ordinary types:

```text
Gamma ; Phi |- c : A ! epsilon
```

`Phi` is keyed by stable immutable-value identities and may contain supported
facts such as:

```text
x = y
x = y + k
0 <= i
i < length(alpha)
length(beta) = length(alpha) + k
InBounds(alpha, i)
```

Aliases preserve a value identity. A new construction or identity-changing
rebind creates another. The first solver is deliberately incomplete and
decidable. Failure to prove a premise means a proof-required operation is
rejected or replaced by a total operation; it never becomes an approximation.

A direct array read has a proof premise:

```text
Gamma ; Phi |- a : Array A
Gamma ; Phi |- i : Int
Phi entails 0 <= i < length(identity(a))
------------------------------------------------
Gamma ; Phi |- get_proved(a, i) : A
```

Its certificate names the saturated operation and every stable premise identity.
Lowering may remove a target bounds branch only after independent replay.
Evidence copied to another occurrence or used after identity-changing rebinding
is invalid.

### 9.2 Coverage

An accepted closed match is statically exhaustive or has an irrefutable arm.
Coverage operates over the complete cross-product of pattern columns. A guarded
arm cannot establish unconditional coverage merely because its guard is often
true. Open or unlistable domains require a catch-all.

An explicit panic in a catch-all is a specified source trap, not a latent
missing-match state.

## 10. Effects, handlers, and continuations

Let `Signature(ell, operation) = A -> B`. Performing the operation has type:

```text
Gamma |- v : A
---------------------------------------------
Gamma |- perform[ell, operation](v) : B ! {ell}
```

When a request for `ell` occurs in a delimited context `E`:

```text
handle ell (E[perform[ell, operation](v)]) with h
  --> h.operation(v, resume)

resume = one-shot (lambda b.
  handle ell (E[return b]) with h)
```

A successful resume re-enters the handler around the captured continuation. The
handler clause itself is not recursively enclosed by the same handler, so a
clause that performs `ell` again emits a new request.

The result row is subtraction followed by clause effects:

```text
Gamma |- c : A ! epsilon_c
Gamma |- h : Handler(ell, A, B, epsilon_h)
-----------------------------------------------------------
Gamma |- handle ell c with h
  : B ! ((epsilon_c \ {ell}) union epsilon_h)
```

`epsilon_h` includes operation clauses and the return clause. Handling an absent
atom is valid: operation clauses are unreachable for that computation, while a
return clause may still transform the result.

A captured continuation is one-shot. Affine ownership permits zero or one
consuming action; linear ownership requires exactly one on every terminating
clause exit. `Continuation.cancel` is an explicit sequenced consuming
destructor. It spends the continuation without entering the captured context. It
proves unique use and structural accounting, not execution of consumers or
finalizers inside the discarded continuation.

Must-finalize resources require an additional protocol such as explicit
finalization, cancellation evidence, or a must-resume restriction.

## 11. Ownership, borrowing, and capability algebra

Ownership is checked separately:

```text
Gamma ; Phi ; Omega |- c : A ! epsilon => Omega'
```

`Omega` maps stable paths to modes:

```text
U  unrestricted: any number of uses
B  borrowed: inspection only; no move or escape
A  affine: at most one consuming use; discard allowed
L  linear: exactly one consuming action on every terminating exit
```

These are not subtype constructors. Erasing `Omega` does not change the ordinary
principal type.

Closures own captured environments. Aggregates carry the joined obligations of
their components. Moving a container moves its owned paths. Partial projection
is accepted only when omitted owned siblings are unrestricted or a consuming
split accounts for every output. Continuing branches must agree on live linear
paths; affine joins are conservative.

A function publishes an erased ownership summary for parameters, callbacks, and
structural results. Passing a linear closure once to a function that invokes it
twice is duplication and is rejected. Recursive ownership needs a checked
transfer or call-count argument; traversal order is not a proof.

A borrow is lexical and non-storable. It may be inspected or passed to a
borrowing parameter; it may not be returned, retained, captured by an escaping
closure, moved, or passed across the host boundary. First-class references would
require a provenance and region calculus.

### 11.1 Destructive reuse

Source values remain immutable. Target storage reuse is allowed only when a
certificate proves unique consuming use, no later source-observable alias, and
complete accounting of owned paths. The target mutation must simulate a fresh
persistent source result. Syntactic last occurrence is insufficient because
closures, branches, recursion, and returned aliases may retain access.

### 11.2 Partitioned capabilities

A capability family supplies a partial ordered footprint composition `p * q`.
Separation, exact cover, deterministic focus, frame locality, and ownership
conservation are family laws. Associativity is conditional:

```text
(p * q) * r defined    p * (q * r) defined
------------------------------------------------
(p * q) * r = p * (q * r)
```

One bracketing need not imply the other. Reassociation consumes exact proof-tree
witnesses and succeeds only when the family validates the new intermediate
composition.

### 11.3 Structural abstraction invariants

Ownership safety and a library abstraction invariant are different claims. The
current ordered-text-map carrier is structurally a Slice of entries. Its
constructor establishes strict key ordering and its exported operations preserve
it. Map-result and logarithmic-cost theorems are conditional on that protocol. A
raw structurally matching Slice remains memory-safe but is not thereby an
abstract ordered map.

## 12. Staging, specialization, and representation

After staging, residual run-time code is closed over compile-time bindings.
Erased type representations, effect descriptors, reflection values, layouts,
tags, proof packages, and included-data computations have already been consumed
into code or checked metadata.

Phase safety is contextual: replacing an erased compile-time value while holding
its generated residual artifact fixed cannot change run-time behavior.

Before Runtime HIR, specialization must:

- instantiate residual polymorphism;
- close record and variant shapes;
- insert or discharge representation-changing coercions;
- specialize handlers and known higher-order choices;
- normalize known deferred calls into ordinary control;
- erase compile-time and proof-only values; and
- attach replayed ownership permissions to Store operations.

A closed accepted internal program that reaches Runtime-HIR validation with an
unresolved representation exposes a compiler invariant failure. A public type or
experimental target outside an explicitly stated policy may instead produce
`TargetRefusal`.

## 13. Public ABI

Only ABI-admissible closed types receive public adapters:

```text
lift_A  : caller-representation -> Result<source A, boundary-trap>
lower_A : source A -> caller-representation plus ownership-obligation
```

For every valid public value:

```text
lift_A(lower_A(v)) ~= v
```

where `~=` ignores private allocation identity and respects canonical ordering.
Malformed UTF-8, booleans, discriminants, pointers, alignments, lengths, and
ownership state trap before an invalid source value is constructed.

`RUNTIME.md` owns the semantic representation relation and admissible type
boundary. `docs/abi.md` owns exact ABI 1 bytes and caller ownership. A seal's
public name is present in the manifest and conformance relation, not dynamically
inside equal raw carrier bytes. Nominal ABI safety therefore assumes a caller
that obeys the declared manifest.

Private Store roots, headers, addresses, closure tables, and target tags do not
cross the boundary. If a required adapter check is unimplemented, public layout
construction returns `TargetRefusal`; accepting an unchecked boundary is an
`InvariantFailure`.

## 14. Failure classes

The compiler distinguishes:

```text
SourceDiagnostic  a language premise is false
LimitDiagnostic   a deterministic documented compiler bound was reached
TargetRefusal     the selected target policy does not admit a checked program
InvariantFailure  an earlier compiler contract was violated
```

Only a `SourceDiagnostic` establishes source invalidity. A limit diagnostic
establishes no source judgment. A target refusal is allowed only at an explicit
policy boundary. Missing facts or failed representation closure after a
successful earlier judgment are invariant failures.

## 15. The theorem package

### 15.1 Frontend

- token and compact-CST determinism for accepted source;
- elaboration totality or a classified source diagnostic;
- preservation of scope, explicit control targets, order, type, effect row, and
  source observations up to administrative Core steps.

### 15.2 Source safety

Preservation is stated over an extendable world of immutable identities,
continuation state, and other semantic allocations:

```text
W ; Gamma ; Phi ; Omega |- c : A ! epsilon
c -> c'
------------------------------------------------
exists W' >= W, Gamma', Phi', Omega'.
  W' ; Gamma' ; Phi' ; Omega' |- c' : A ! epsilon
```

One-step progress for a closed well-typed computation classifies it as a return,
able to step, an unhandled request named by its row, or a specified trap.
Divergence belongs to the maximal-execution theorem: every maximal execution
reaches a classified finite outcome or contains infinitely many reductions.

Coverage safety excludes missing arms. Relationship safety requires every
proof-required operation to satisfy its replayed proposition. Ownership safety
is mode-indexed: no path is moved twice or through a borrow, affine paths are
not duplicated, and linear paths are accounted for on every terminating exit.
Reuse adequacy relates every permitted target mutation to its persistent source
operation.

### 15.3 Compiler correctness

For a pass relation `R_i`, finite source steps may be matched by zero or more
target administrative steps, but weak forward simulation alone is insufficient.
Each pass additionally supplies progress-sensitive adequacy:

1. an empty target match decreases a well-founded stuttering rank;
2. a related source return, request, or trap reaches the matching target outcome
   after finitely many administrative steps;
3. every target return, request, or trap is reflected by the source;
4. related request/response protocols resume related continuations; and
5. infinite related executions preserve demanded divergence rather than
   collapsing it into a finite unrelated outcome.

A progress-sensitive weak bisimulation is an equivalent proof shape. Composition
produces the whole-compiler theorem: for a closed accepted program and related
host responses, source evaluation and emitted WebAssembly have the same returns,
requests, specified traps, and divergence, modulo the representation relation
and explicit target restrictions.

A defensive target check may remain only with proof that related validated
states cannot reach it. Reaching one is an invariant failure, not a permitted
extra trap.

## 16. Evidence and trusted boundaries

Examples are fixtures, not proofs. Generated tests, mutation tests, differential
evaluation, certificate replay, Runtime-HIR validation, Wasm validation, ABI
round trips, and formal models address different failure classes.

A certificate checker reduces trust only when it is smaller than the producer,
reconstructs every premise from stable identities, and rejects evidence copied
to another expression or revision. A complicated producer may remain outside a
mechanized core through translation validation; determinism alone does not turn
its output into an axiom.

The current Lean development models selected Core boundaries. Its logical
assurance and its correspondence to production parser, checker, ownership,
staging, Runtime-HIR, and ABI artifacts are separate claims.

## 17. Open extensions

The following remain explicit design choices rather than hidden ambiguity:

- a must-finalize resource protocol;
- first-class borrow provenance and regions;
- a larger decidable relationship fragment;
- additional intrinsic numeric or word domains;
- specialization by cloning, representation dictionaries, or a combination;
- nominal or revalidated library abstractions over structural carriers; and
- the next stable production-to-Lean correspondence theorem.

Each extension must preserve the interfaces between ordinary inference,
proposition entailment, ownership, phase erasure, representation validation,
public adapters, and progress-sensitive target adequacy.

## 18. Research context

Blot combines established ideas without inheriting their theorems automatically:

- algebraic-subtyping lower/upper-bound inference;
- call-by-push-value's value/computation distinction;
- algebraic effects and handlers;
- elaboration from a richer strict surface to a smaller Core;
- linear interfaces with controlled destructive implementation;
- provenance-aware reasoning for escaping references; and
- WebAssembly validation and execution.

The research claim is the explicit composition and boundary discipline: staged
compile-time values, a fixed GPU-profile surface, algebraic subtyping,
relationship evidence outside the type lattice, generative effects, structural
ownership, representation-closed Runtime HIR, and a versioned canonical
WebAssembly interface under one observational compiler theorem.
