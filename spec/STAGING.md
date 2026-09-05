# Staging and specialization

## Status and scope

[`LANGUAGE.md`](../LANGUAGE.md), subject to [`COHERENCE.md`](COHERENCE.md),
defines which source expressions are required to resolve at compile time. This
document owns compile-time evaluation, phase-erasure, specialization, and
representation-closure obligations.

Staging is not an optimizer that may guess whether an expression is convenient
to evaluate. Required compile-time evaluation is part of checking; optional
partial evaluation must preserve the same residual source meaning.

## 1. Phase judgments

Compile-time availability and run-time typing are separate judgments:

```text
Delta ; I |-ct e downarrow w ; I'
Gamma |-rt c : A ! epsilon
```

`Delta` contains only compile-time-available bindings. `I` is the
compiler-controlled identity and explicit-input world. It includes the source
revision, resolved module-instance stack, included byte identities, compiler
schema, primitive catalog, and other inputs that the evaluated expression may
observe.

A run-time binding cannot occur free in a compile-time type, effect descriptor,
layout, declaration tag, reflection decision, specialization choice, or public
ABI shape.

## 2. Compile-time authority

Compile-time evaluation has no ambient host authority. It may observe only:

- compile-time bindings in `Delta`;
- dependency-resolved module inputs;
- explicitly included bytes and their declared transform;
- deterministic compiler primitives admitted by the staging contract; and
- compiler-owned identity allocation under `I`.

Source effects and public host capabilities are unavailable. An import or
include is not an ambient filesystem read: dependency resolution supplies an
explicit revisioned input before evaluation begins.

Operator spelling and precedence are not staged values. They are collected from
the source syntax prelude and the module's bounded fixity header before
elaboration.

## 3. Checked bridges

A compile-time value acquires semantic authority only through the bridge owned
by its use site:

```text
bridgeType   : CTValue -> Result<CoreType, SourceDiagnostic>
bridgeEffect : CTValue -> Result<EffectDescriptor, SourceDiagnostic>
bridgeLayout : CTValue -> Result<LayoutDescriptor, SourceDiagnostic>
bridgeTag    : CTValue -> Result<DeclarationTag, SourceDiagnostic>
```

The bridges are partial. A closure that can compute a type is not itself a type;
it must be applied at compile time. A record that resembles an effect descriptor
has no effect identity until `bridgeEffect` validates it. A layout value cannot
smuggle a run-time dependency or private target pointer into public metadata.

A decoder may return a concrete value with a widened sound type:

```text
(w, A, proof that w inhabits A)
```

This is checked evidence, not an unchecked type annotation and not a second
run-time value.

## 4. Determinism and limits

For fixed `Delta`, `I`, compiler schema, and primitive catalog, successful
compile-time evaluation is deterministic up to alpha-renaming of identities that
are explicitly hidden by the result relation.

A required compile-time computation may diverge in the source semantics. The
implementation may stop first at a documented deterministic fuel, stack, memory,
or expansion bound. Such exhaustion is a `LimitDiagnostic`, including
`BLOT_EVALUATION_LIMIT`:

- it is not a source value;
- it is not a source trap or divergent execution;
- it proves neither acceptance nor rejection; and
- raising the bound may let the same source revision finish without changing
  language meaning.

A semantic bridge failure, forbidden phase dependency, or effectful compile-time
expression is instead a `SourceDiagnostic`.

Optional speculative evaluation has a weaker contract. Failure to evaluate an
otherwise residual empty-row expression does not authorize erasure; the
expression remains residual unless the language requires compile-time
resolution.

Finite compile-time unions are flattened, retain the first semantic occurrence
of each member, and compare as sets. The evaluator may keep an indexed
persistent member representation, but an index collision must fall back to exact
type-value equality and extending an aliased union must not mutate the alias.

Within one staging execution, a successful closure call may reuse a prior result
only when its settled arrow is monomorphic and has a closed empty effect row,
the call is not residual, and both argument and result are closed first-order
values. The key contains the closure's exact creation environment,
module-instance stack, effect scope, body identity, and a structural argument
value. Functions, effects, operations, capabilities, Regions, Scratch values,
continuations, residual values, open effects, and type variables are not cache
keys or cached results. Failures are not cached. The bounded cache is local to
that execution and therefore cannot outlive a revision or substitute one module
occurrence for another. This changes evaluation work only; the exported runtime
body retains the source algorithm.

## 5. Generative and applicative identities

### 5.1 Ordinary effects

Ordinary source effects are generative. Evaluating a declaration allocates
under:

```text
(module instance, declaration node, compile-time scope, signature)
```

Administrative re-evaluation of the same recorded occurrence recovers the same
atom. Evaluation under another module-instance stack mints a distinct atom even
when the operation descriptors are structurally equal.

The compile-time scope component is the ordered stack of revision-qualified
source application identities, including each callee's recorded creation scope.
Compiler-owned closure applications carry a typed sub-occurrence rooted in the
source expression, declaration, effect request, or export parameter that owns
them. Repeated evaluation of one stack is stable; a second written call or an
additional recursive frame is distinct. Signature equality is exact semantic
type-value equality, including alpha-equivalence and referenced effect atoms;
neither displayed values nor partial hashes are identity evidence.

A resident nullary module result may replace administrative re-evaluation only
when its checked effect row is empty, its closed result type exposes no ordinary
or host effect identity, and the actual value is recursively independent of its
producing module instance. In particular, a closure can invoke a caller-supplied
effect constructor, so an effect-free result type alone cannot justify sharing
that closure. Values containing closures, deferred environments, function
choices, effects, operations, Regions, continuations, or residual runtime values
are evaluated under each written module-instance occurrence as above. An
authenticated snapshot may avoid replaying declarations by decoding its
validated environment as a template over the current occurrence's complete
module-instance and compile-time scope stacks. This is per-occurrence
instantiation, not resident-result sharing.

A reusable cache entry containing an ordinary effect is valid only when the
complete owning instance identity and revision are preserved. A module path or
declaration spelling alone is insufficient.

### 5.2 Seals

Seals are applicative rather than generative. Their identity is:

```text
(public name, canonical closed invariant carrier)
```

Reconstructing equal inputs reconstructs the same seal across evaluations and
revisions. Cache identity therefore retains the normalized public name and
canonical carrier; it does not substitute a declaration occurrence or fresh
atom.

### 5.3 Other compile-time identities

Every identity-producing primitive states whether it is:

- generative under a complete semantic occurrence;
- applicative in canonical input values; or
- merely an administrative compiler identity hidden by the semantic relation.

A new identity class cannot inherit the rule of an existing class because its
printed representation happens to match.

## 6. Required phase erasure

After staging, residual run-time code is closed over compile-time bindings.
Erased values include, where applicable:

- type representations;
- effect and layout descriptors;
- reflection values;
- declaration tags;
- proof-only relationship packages;
- ownership summaries and certificates;
- included-data computations; and
- known specialization decisions.

Erasure consumes these values into residual code or checked metadata. A residual
read of an erased binding is an invariant failure.

The phase-safety obligation is contextual:

> Replacing an erased compile-time value while holding its checked residual
> artifact fixed cannot change run-time observations.

The qualification about the residual artifact matters: changing a type or layout
may legitimately produce different residual code during a fresh compilation.

## 7. Partial evaluation

An optional partial evaluator may reduce a closed pure fragment when it proves
that the replacement preserves:

- demand;
- source evaluation order;
- specified traps and divergence;
- generative identity allocation;
- relationship and ownership certificate premises; and
- source-origin information needed by diagnostics.

An empty effect row alone is not enough. A computation can still trap or
diverge, and moving it across a branch can change whether it is demanded.

Partial evaluation cannot duplicate a generative declaration, merge two module
instances, turn a one-shot demand into multiple demands, or use target layout as
a source proof.

## 8. Specialization

Specialization consumes typed residual Core plus phase, safety, ownership, and
representation facts. Before Runtime HIR it must:

1. instantiate every residual quantified use;
2. close record and variant representation choices;
3. settle every residual effect and handler representation;
4. insert or discharge representation-changing coercions;
5. specialize known higher-order and deferred choices;
6. erase compile-time and proof-only values;
7. choose a concrete representation for every residual aggregate and closure;
8. attach replayed ownership permission to destructive Store operations; and
9. retain complete public metadata for ABI closure.

Known deferred calls are normalized into ordinary residual control. Runtime HIR
has no general thunk value merely because the source used a deferred parameter.
An unresolved deferred closure that escapes known application is a stated target
refusal, not an implicit new ABI object.

## 9. Representation closure

Write:

```text
closedRep(hir)
```

when every Runtime-HIR value, branch join, call argument, result, field,
constructor payload, closure environment, Store element, and public boundary has
one target-admissible representation.

Runtime-HIR construction succeeds only with `closedRep`. In particular Runtime
HIR contains no:

- live inference variable;
- unresolved source `forall`;
- open structural shape;
- compile-time value or proof package;
- representation choice selected by observation order; or
- unchecked proof-required operation.

Specialization lowers a residual aggregate only against its checked closed
representation. Array prefixes, later elements, constructor payloads, recursive
arguments, and branch results share the same representation-directed lowering
judgment. Inferring an aggregate layout from its first element after checking,
or borrowing the layout of an equal-looking staged value when checked views
disagree, violates `closedRep` and is an invariant failure. A decoded immutable
aggregate may reuse a structural memo only when every recorded checked view has
the same closed representation.

The checked-aggregate memo is queried online while Runtime HIR is constructed.
Equality of its structural keys must therefore imply equality of the complete
runtime representation at the moment of lookup: runtime leaves retain their
trace-local type identity, known static leaves retain their scalar or SIMD
class, and a value with an unknown leaf or an untyped empty-array element has no
structural key. Discovering a conflicting checked view later cannot repair HIR
already emitted with the wrong layout. This online concrete-value memo is
distinct from call-specialization representation facts, whose observations are
collected before their coarser structural keys are read.

A validation failure caused only by unresolved representation for a closed
accepted internal program is an `InvariantFailure`. An explicitly unsupported
public ABI type or experimental target feature may return `TargetRefusal` at its
stated policy boundary.

## 10. Artifact and cache coherence

A staged or specialized cache entry includes every input observed by its phase:

```text
CacheKey = hash(
  compiler and certificate schema,
  source and dependency revisions,
  complete module-instance identity,
  included bytes,
  primitive catalog,
  language plan,
  target and ABI policy
)
```

A phase may omit an input only after proving it cannot observe it. Cached values
containing generative effects preserve their owning occurrence identity. Cached
seals reconstruct their canonical applicative inputs. Live inference variables,
AST object addresses, mutable worklists, and process-local proof sinks never
cross a serialized cache boundary.

Decoding validates every reference and closed identity before exposing the
artifact. A content hash proves transport integrity; it does not prove that a
package-controlled claimed interface follows from its source.

## 11. ABI handoff

Specialization supplies public-layout construction with:

- a closed source type;
- a closed Runtime-HIR representation;
- ownership policy;
- versioned target policy; and
- canonical lifting/lowering metadata.

Public-layout construction either produces a validated adapter and manifest
entry or returns `TargetRefusal`. It cannot accept a type whose required
malformed-input checks are unimplemented.

Exact ABI 2 bytes are owned by [`docs/abi.md`](../docs/abi.md); the semantic
representation relation is owned by [`RUNTIME.md`](RUNTIME.md).

## 12. Obligations

Staging and specialization owe:

1. compile-time determinism for fixed explicit inputs;
2. phase separation and absence of residual erased reads;
3. correct generative effect and applicative seal identity;
4. distinction between source failure and compiler-limit refusal;
5. demand-, trap-, divergence-, and identity-preserving partial evaluation;
6. complete residual instantiation;
7. representation closure before Runtime HIR;
8. independent replay of proof and ownership certificates;
9. cache coherence under complete observed revisions; and
10. operational adequacy between staged source, specialized Core, and validated
    Runtime HIR.

Tests and validation passes provide finite evidence for these obligations. A
successful build does not by itself prove phase safety or the whole-compiler
observation theorem.

### Source-member carrier evidence

An inferred-type member application remains a source application during staging.
The selected attached closure or primitive determines behavior; a field spelling
is not an alternative semantic contract. Prefix negation uses the same boundary
as binary operators, and arbitrary attached member names do not require an HIR
operator whitelist.

When specialization receives a scalar Runtime value whose source type variable
has already been substituted by an admitted HIR representation, staging may
reify that checked carrier (`Int`, `F64`, `F32`, `Bool`, `Text`, or a supported
SIMD carrier) to select its source member. This reads the validated type
identity; it does not infer a new source type, prove a refinement, or choose
semantics from sample data. Existing checked source type evidence takes
precedence. Missing carrier evidence must not manufacture a type variable with a
built-in operator namespace attached to it.
