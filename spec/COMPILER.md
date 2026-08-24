# Compiler contract

## Status and scope

This document owns the compiler-wide judgment, phase graph, fact ownership,
failure taxonomy, determinism conditions, and validation boundaries. Exact source
and focused semantic rules live in the documents indexed by
[`README.md`](README.md), with cross-document constraints in
[`COHERENCE.md`](COHERENCE.md).

The compiler implements one language judgment. A fast path, cache hit, resident
server, batch scheduler, auxiliary evaluator, or target backend may validate or
memoize that judgment; it cannot define a weaker semantic mode.

## 1. Whole-compiler judgment

Let:

- `Sigma` be compiler schema, generated language plan, primitive catalog, and
  certificate versions;
- `G` be a complete resolved source graph, including import and include inputs;
- `tau` be target and ABI policy;
- `W` be a WebAssembly module;
- `M` be its canonical public manifest; and
- `D` be an ordered diagnostic set.

Write successful compilation as:

```text
Sigma ; tau |- G downarrow Success(W, M)
```

Other classified results are:

```text
Diagnostics(D)
TargetRefusal(reason)
InvariantFailure(reason)
```

`D` contains disjoint diagnostic meanings:

```text
SourceDiagnostic  a source-language premise is false
LimitDiagnostic   a documented deterministic compiler resource bound was reached
```

Only a source diagnostic establishes that a language derivation failed. A limit
diagnostic establishes neither acceptance nor rejection and is not a source
return, request, trap, or divergence.

Successful compilation has no diagnostics. The sidecar and embedded manifest
bytes are identical.

## 2. Input world

A compilation revision includes every input any selected phase may observe:

```text
Revision(G, tau) = hash(
  compiler and certificate schema,
  generated parser and operator plan,
  root and dependency source bytes,
  resolved import occurrence graph,
  included bytes and transforms,
  primitive catalog,
  package/capsule policy,
  target and ABI policy
)
```

A phase-specific key may omit a component only after proving the phase cannot
observe it. Source identity, module-definition identity, import occurrence,
module instance, effect atom, seal, Store root, and artifact revision remain
distinct.

Ambient current directory, process environment, network state, clock, random
state, or undeclared host capability is not a compiler input unless a future
language revision makes it explicit and revisioned.

## 3. Pass graph

The production pass graph is:

```text
source bytes
  -> tokens and compact CST
  -> resolved surface AST
  -> value/computation Core
  -> demanded Core
  -> ordinary type-and-effect checking
  -> coverage and relationship checking
  -> ownership and reuse checking
  -> compile-time evaluation and residualization
  -> representation-closing specialization
  -> validated Runtime HIR
  -> public-layout construction
  -> WebAssembly and manifest
```

Every pass has:

- a typed input artifact;
- a typed output artifact;
- an explicit set of facts it may read;
- a complete set of facts it produces;
- classified failures;
- deterministic identity allocation;
- a validator or downstream replay point where appropriate; and
- a local simulation or adequacy obligation.

A later pass may consume or replay an earlier fact. It may not infer a replacement
from printed names, source spelling, target layout, or optimization artifacts.

## 4. Frontend facts

The frontend produces:

```text
TokenId
CompactNodeId
SourceSpan
ResolvedBindingId
ControlTargetId
ImportOccurrenceId
SourceOrigin
```

`grammar.baba` is the only parse authority. Operator grouping uses the generated
fixed language plan; source modules cannot create a fixity environment. Layout
continues expressions but creates a statement value only through `do:` or
`compdo:`.

Surface elaboration is hygienic and preserves source origins. Every function
application becomes a Core computation; an empty effect row does not create a
second pure-application artifact.

An incremental frontend result must equal a fresh result, including diagnostics,
spans, compact edges, and resolved identities.

## 5. Demand facts

After resolution and surface elaboration, the compiler builds the lexical binding
dependency graph and computes:

```text
live(block, result) = L
```

Dead pure declarations are absent from the source program being checked. Forced
declarations and every declaration reachable from the result remain in source
order.

The demand artifact records:

- live binding identities;
- resolved dependency edges;
- forced declaration reasons; and
- source origins for erased declarations needed by diagnostics or tooling.

Demand is fixed before optimization. Ownership consumes the demanded artifact.
A consuming action inside an erased declaration cannot satisfy a linear use
obligation.

## 6. Ordinary checking

Ordinary checking produces:

```text
ClosedOrBoundedType
EffectRow
TypedCoercion
CompileTimeIdentity
TypedCoreOrigin
```

The open rank-1 algebraic core uses lower/upper-bound inference. Rank-N
subsumption, checked reflection, closed ground operations, predicate
normalization, relationships, ownership, and representation closure remain
separate checked boundaries.

Every application is typed as a computation. A source pure position may bind its
result only after the row settles empty. Effect emptiness does not establish
termination or absence of traps.

A missing ordinary premise yields a source diagnostic. An internal mutable graph,
worklist, or unconstrained inference variable never crosses a closed interface or
cache boundary.

## 7. Safety checking

### 7.1 Coverage

Coverage produces an exhaustiveness result for every closed match, with complete
pattern-column and guard evidence. An accepted match is exhaustive or has an
irrefutable arm. A missing arm is a source diagnostic; it is never deferred to a
Runtime-HIR stuck state.

### 7.2 Relationships

Relationship checking carries propositions keyed by stable immutable-value
identities. A proof-required operation produces a certificate containing:

- source revision;
- saturated operation identity;
- exact premise value identities;
- normalized proposition; and
- solver/checker schema.

A validator reconstructs the proposition and rejects copied, stale, foreign, or
identity-mismatched evidence.

### 7.3 Ownership

Ownership checking carries path-indexed modes:

```text
unrestricted
borrowed
affine
linear
```

It produces closure summaries, branch states, consumed-path facts, partition
witness lineage, and destructive-reuse certificates.

The checker enforces mode-specific rules: affine discard is permitted; linear
paths require one consuming action on every terminating exit. A consuming
operation is not assumed to run a domain-specific finalizer unless its own
contract says so.

## 8. Compile-time evaluation

Compile-time evaluation runs only with compile-time bindings and explicit
revisioned inputs. Source and host effects are unavailable.

Checked bridges interpret compile-time values as types, effect descriptors,
layouts, declaration tags, or reflection data. Operator fixity is not a staged
value; it comes from the generated language plan.

Identity policy is explicit:

- ordinary source effects are generative under complete module-instance,
  declaration, and compile-time-scope identity;
- seals are applicative in public name and canonical invariant carrier; and
- administrative compiler identities are hidden only when the semantic relation
  says so.

A semantic phase violation or failed required bridge is a source diagnostic. A
documented fuel, memory, stack, or expansion bound is a limit diagnostic.

## 9. Staging and specialization

Staging erases compile-time and proof-only values after consuming them into
residual code or checked metadata. Residual code is closed over compile-time
bindings.

Specialization closes:

- residual quantified uses;
- record and variant representations;
- effect and handler representations;
- closure environments;
- branch joins;
- deferred-call choices;
- Store element layouts; and
- public type metadata.

It inserts explicit representation coercions and attaches replayed ownership
permission to destructive operations.

A closed production-supported internal program that remains representation-open
at Runtime-HIR construction exposes an invariant failure. An explicitly
unsupported public type or experimental target feature may yield target refusal
at its stated policy boundary.

## 10. Runtime-HIR production and validation

Runtime HIR is constructed only after representation closure. The producer emits
closed operations, values, control flow, Store lineage, host requests, traps,
and public metadata.

The validator independently checks:

1. structural reference validity;
2. control-flow and branch-argument agreement;
3. closed operation and call representations;
4. exact relationship-certificate replay;
5. exact ownership and reuse permission;
6. Store/root and capability-family lineage;
7. absence of compile-time and proof-only values;
8. target-policy admission; and
9. complete public-layout inputs.

Producer success followed by validator failure is an invariant failure. The
validator does not generate a new source diagnostic by reconstructing source
syntax.

## 11. Public layout and ABI

Public-layout construction is partial over closed checked types:

```text
publicLayout(tau, A, ownership)
  -> PublicLayout
   | TargetRefusal
```

It returns target refusal for types or features outside the declared policy. It
must not accept a boundary whose required malformed-input validation is
unimplemented.

`RUNTIME.md` owns the semantic source/caller relation.
`docs/abi.md` owns exact ABI 1 bytes and caller ownership.

For every admitted type, lifting validates before constructing a source value,
and valid values round-trip through lowering and lifting up to the representation
relation. Seal names are manifest/conformance facts; equal raw carrier bytes do
not dynamically enforce source nominality.

Private Runtime-HIR roots, live capabilities, proof witnesses, unsupported
closures, and other no-layout values are refused before emission. Reaching the
emitter with such a public boundary is an invariant failure.

## 12. Emission

The emitter accepts only validated Runtime HIR and public layout. It produces:

- a WebAssembly module accepted by the Core validator;
- the canonical manifest bytes;
- optional deterministic side products explicitly named by the build contract;
  and
- no untracked source-semantic fact.

A target trap is permitted only when related to a specified source trap or a
versioned malformed-boundary/ownership trap. A defensive internal check may
remain only when related valid states cannot reach it; reaching one is an
invariant failure.

Emission uses the overflow, bounds, NaN, order, ownership, and host-call behavior
selected by the validated Runtime-HIR operation rather than incidental target
instruction behavior.

## 13. Failure classes

### 13.1 SourceDiagnostic

A source diagnostic means a source-language premise is false, for example:

- parse or resolution failure;
- forbidden phase dependency;
- failed type, effect, coverage, relationship, or ownership premise;
- unsupported source operation under the language profile; or
- required compile-time value that evaluates to the wrong semantic kind.

It may be cached only under the exact observed revision and diagnostic schema.

### 13.2 LimitDiagnostic

A limit diagnostic means a documented deterministic compiler resource bound was
reached, for example `BLOT_EVALUATION_LIMIT`.

It establishes no source rejection and is not part of source execution.
Increasing the bound may let the same source revision compile successfully.
Limit diagnostics are deterministic for the fixed configured bounds and remain
separate from target refusal.

### 13.3 TargetRefusal

Target refusal means a checked program lies outside the selected target or ABI
policy. It is permitted only at an explicit policy boundary, such as a public
vector type refused by ABI 1 or an experimental target feature not enabled for
production.

It cannot hide an unresolved production-supported internal representation,
missing certificate, accepted-but-unvalidated public input, or private object
that leaked past specialization.

### 13.4 InvariantFailure

An invariant failure means a compiler contract previously claimed to hold has
been violated, including:

- producer/validator disagreement;
- missing fact after successful checking;
- unstable semantic identity;
- unresolved supported representation;
- target-only visible outcome;
- accepted public layout without required validation; or
- manifest and emitted adapter disagreement.

Invariant failure is never downgraded to a source diagnostic.

## 14. Determinism

For fixed complete revision, target policy, documented limits, and compiler
schema, the compiler result is deterministic:

```text
compile(input) = result_1
compile(input) = result_2
--------------------------------
result_1 = result_2
```

Equality includes ordered diagnostics, closed interfaces, certificates,
Runtime-HIR artifacts, manifest bytes, and WebAssembly bytes modulo only the
explicitly hidden identity relation.

Parallel work may run independent ready nodes concurrently. Commit order follows
a canonical module order, diagnostic order follows source order, and no mutable
inference graph crosses a worker boundary.

## 15. Incremental and cached compilation

Incremental compilation is memoization of fresh compilation. For phase `P`:

```text
key_P(x) = key_P(x')    validate(cached(P(x')), x)
-------------------------------------------------
P(x) = cached(P(x'))
```

A cache key contains every input observed by the phase. Reuse cannot merge
separate import occurrences, module instances, generative effect atoms, Store
roots, ownership lineages, or source revisions.

Closed interface decoding validates scopes and freshens quantified identities.
Mutable bounds, worklists, AST object addresses, and fact sinks do not cross the
cache boundary. A content hash proves transport integrity, not semantic
correctness of a package-controlled claimed interface.

A cache hit and fresh compilation produce equivalent results; only work changes.

## 16. Artifact production

Generated parser plans, prelude snapshots, certificate schemas, compiler Wasm,
and package capsules are source-derived artifacts with explicit manifests.

A tracked or distributed artifact is accepted only after validating:

- schema and compiler version;
- exact source/dependency revision;
- language-plan and primitive-catalog identity;
- internal reference ranges and closed scopes;
- target and ABI policy; and
- any cheaper proof certificate the artifact claims to carry.

A stale artifact is regenerated or rejected according to its distribution
contract. It does not silently become source authority.

The packaged compiler's stack, memory, and evaluator limits are implementation
budgets. They do not alter emitted-program memory or prove negative source
judgments when exhausted.

## 17. Pass correctness

Each pass publishes a local relation and progress-sensitive adequacy package as
specified by [`CORRECTNESS.md`](CORRECTNESS.md). Weak forward simulation alone is
insufficient.

The composed theorem preserves and reflects:

```text
Return
Host request/response protocol
Specified source trap
Specified malformed-boundary trap
Divergence
```

for closed accepted programs, admitted public layouts, and conforming related
hosts. Target-only finite outcomes and infinite administrative stuttering are
excluded.

## 18. Validation and test obligations

Production acceptance requires layered evidence:

1. parser and incremental-frontend equivalence;
2. hygiene and explicit-control elaboration;
3. demand erasure and empty-row application regressions;
4. type, effect, coverage, relationship, and ownership checking;
5. certificate mutation and replay rejection;
6. effect/module/seal identity tests;
7. capability-family law and stale-witness tests;
8. staging, specialization, and Runtime-HIR validation;
9. source/Rust/Wasm differential observations;
10. ABI valid round trips and malformed-input traps;
11. deterministic artifact and manifest regeneration; and
12. formal checks for the stable Core fragment with no admitted declarations.

A passing example is evidence, not a replacement for the named theorem or
validator.

## 19. Trusted computing base

The trusted computing base includes the parser plan and implementation,
resolution and elaboration, declarative rule implementations or their validators,
certificate checkers, Runtime-HIR validator, public-layout builder, emitter,
manifest encoder, and the WebAssembly engine assumptions used by the theorem.

Trust is reduced when:

- a small validator reconstructs producer premises;
- generated artifacts are tied to exact source revisions;
- semantic identity classes are explicit;
- unsupported boundaries refuse before emission; and
- production artifacts are connected to mechanized models by a checked
  translation.

A theorem about a seed calculus does not automatically cover the production
frontend, module system, ownership checker, specialization, Runtime HIR, or ABI.
