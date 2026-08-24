# Staging and specialization

## Status and scope

[`LANGUAGE.md`](../LANGUAGE.md), subject to
[`COHERENCE.md`](COHERENCE.md), defines which source expressions are required to
resolve at compile time. This document owns compile-time evaluation,
phase-erasure, specialization, and representation-closure obligations.

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

Source effects and public host capabilities are unavailable. An import or include
is not an ambient filesystem read: dependency resolution supplies an explicit
revisioned input before evaluation begins.

Operator spelling and precedence are not staged values. They are fixed by the
generated language plan before elaboration.

## 3. Checked bridges

A compile-time value acquires semantic authority only through the bridge owned by
its use site:

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

## 5. Generative and applicative identities

### 5.1 Ordinary effects

Ordinary source effects are generative. Evaluating a declaration allocates under:

```text
(module instance, declaration node, compile-time scope, signature)
```

Administrative re-evaluation of the same recorded occurrence recovers the same
atom. Evaluation under another module-instance stack mints a distinct atom even
when the operation descriptors are structurally equal.

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

An empty effect row alone is not enough. A computation can still trap or diverge,
and moving it across a branch can change whether it is demanded.

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
AST object addresses, mutable worklists, and process-local proof sinks never cross
a serialized cache boundary.

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

Public-layout construction either produces a validated adapter and manifest entry
or returns `TargetRefusal`. It cannot accept a type whose required malformed-input
checks are unimplemented.

Exact ABI 1 bytes are owned by [`docs/abi.md`](../docs/abi.md); the semantic
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
