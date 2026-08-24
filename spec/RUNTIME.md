# Runtime HIR and WebAssembly boundary

## Status and scope

This document owns:

- the admissible Runtime-HIR language;
- validation before emission;
- the semantic representation relation between source, Runtime HIR, and caller
  values;
- public-layout admissibility; and
- the Runtime-HIR-to-WebAssembly correctness obligation.

[`docs/abi.md`](../docs/abi.md) is normative for exact Core Wasm ABI 1 bytes,
canonical lifting/lowering encodings, and caller ownership. Its **Runtime target
status** section is operational and cannot weaken a rule for an artifact the
compiler accepts. Cross-document corrections are in
[`COHERENCE.md`](COHERENCE.md).

## 1. Runtime-HIR boundary

Runtime HIR is the first artifact whose operations and representations are fully
target-facing. It is constructed only after ordinary checking, safety analysis,
ownership checking, staging, and representation-closing specialization.

A Runtime-HIR module contains:

- first-order control-flow graphs;
- closed scalar and aggregate representations;
- explicit calls and host requests;
- explicit Store allocation, read, write, root, and release operations;
- explicit traps classified by source or boundary contract;
- closed closure environments where supported;
- complete public import/export metadata; and
- compact references to replayed certificates where validation still requires
  them.

It contains no:

- source inference variable or unresolved `forall`;
- open record, variant, effect, or representation choice;
- compile-time value, reflection object, or proof-only package;
- general run-time thunk introduced only for a known deferred source call;
- source binding name used as semantic evidence;
- unchecked proof-required operation; or
- private capability object crossing ABI 1.

## 2. Validation

Write:

```text
validate_hir(H, facts, target_policy) = Ok(H_valid)
```

Validation independently checks at least:

1. every block, value, operation, and metadata reference is in range;
2. control-flow predecessors and branch arguments agree;
3. every operation receives its closed expected representation;
4. calls agree with closed parameter, result, effect, and calling-convention
   metadata;
5. proof-required operations name replayable certificates for the exact
   occurrence and premise identities;
6. destructive Store operations name ownership permission for the exact
   consumed path and source occurrence;
7. Store/root lineage is not duplicated, forged, or crossed between families;
8. every public boundary has an admissible closed source type and adapter policy;
9. no compile-time or proof-only value remains; and
10. every target feature used is admitted by the selected production policy.

The producer and validator may share data structures, but validation is a
separate judgment. A missing fact after successful earlier checking is an
`InvariantFailure`, not a new source diagnostic.

## 3. Runtime observations

Finite Runtime-HIR observations are related to source observations:

```text
Return(value)
Request(capability, operation, argument, continuation protocol)
Trap(specified source or malformed-boundary trap)
```

Divergence is an infinite maximal execution. Allocation addresses, Store
headers, closure indices, administrative blocks, and private tags are hidden by
the relation.

A host request is compared as a protocol. Related runs agree on the declared
capability identity, operation, and related argument. A host response resumes a
related one-shot continuation. Raw target continuation addresses are not source
values and need not be equal.

## 4. Store semantics

A Store is target authority over storage. Store and root identities are not
ordinary source value identities.

Source arrays, records, and other persistent values remain immutable. A
Runtime-HIR Store write may implement a source-persistent operation only when a
replayed ownership certificate proves:

- a unique consuming use at the exact source occurrence;
- no source-observable alias remains usable afterward;
- every owned component path is transferred or otherwise accounted for; and
- the write preserves the operation's relationship and representation
  invariants.

The target write is related to construction of a fresh source result. It does not
retroactively make source aliases mutable.

Borrowed reads never grant Store ownership. Splits and joins consume exact family,
root, footprint, and produced-value lineage. Equal-looking intervals or roots are
not interchangeable.

## 5. Public layout judgment

Public layout is a checked partial function:

```text
publicLayout(version, A, ownership_policy)
  : Result<PublicLayout(A), TargetRefusal>
```

It accepts only closed ABI-admissible types. Private layouts, live capabilities,
proof witnesses, compiler closures without a public representation, and
unsupported recursive roots return `TargetRefusal` before emission.

Reaching the emitter with a public boundary for which `publicLayout` has no case
is an `InvariantFailure`.

For every admitted type `A`, the compiler constructs:

```text
lift_A  : caller representation -> Result<source A, boundary trap>
lower_A : source A -> caller representation plus ownership obligation
```

For every valid public source value:

```text
lift_A(lower_A(v)) ~= v
```

`~=` preserves source-visible structure while ignoring private allocation
identity and respecting canonical ordering.

## 6. Boundary validation

Lifting validates before constructing an interior source value. Required checks
include, where applicable:

- UTF-8 validity;
- canonical boolean encoding;
- discriminant range and payload shape;
- pointer range, alignment, and memory extent;
- length overflow and element extent;
- canonical ordering requirements;
- caller/callee ownership state; and
- absence of private or stale capability handles.

If a required check is not implemented for a public type, the compiler refuses
that boundary. Accepting an unchecked boundary is not an implementation
limitation hidden inside a successful artifact; it is an `InvariantFailure`.

Malformed input takes the versioned boundary trap before a Blot value is
constructed. A conforming host may still diverge, trap according to its declared
contract, or fail to respond.

## 7. Seals at the boundary

A seal is nominal in source through its public name and canonical invariant
carrier. ABI 1 may lower it transparently to the carrier representation, while
the manifest records the public name and carrier contract.

The public name therefore distinguishes contracts for conforming tooling and in
the semantic representation relation. Equal raw Core Wasm carrier bytes do not
dynamically contain the name. A hostile caller can physically pass one equal
carrier where another is expected; the ABI theorem assumes a caller that obeys
the declared manifest, just as it assumes declared ownership and operation
protocols.

No claim of dynamic nominal enforcement follows from the byte layout alone.

## 8. Manifest coherence

The public manifest is part of the artifact theorem. The compiler emits one
canonical byte sequence and, where both forms are produced, requires:

```text
embedded_manifest_bytes = sidecar_manifest_bytes
```

The manifest includes ABI version, imports, exports, closed public types,
ownership policy, seal names where relevant, and every representation parameter
needed by a conforming adapter.

Manifest ordering and encoding are deterministic. A caller may reject an unknown
version before invoking the module.

## 9. WebAssembly emission

Emission translates validated Runtime HIR to WebAssembly accepted by the
WebAssembly Core validator. Target code may contain administrative checks and
steps, but their observation status is constrained.

A target trap is permitted only when it corresponds to:

- a specified source trap; or
- a malformed-input or ownership trap required by the public ABI.

A defensive internal check may remain only with proof that related validated
states cannot reach it. Reaching one is an `InvariantFailure`, not a third class
of permitted target trap.

Integer arithmetic, memory operations, and host calls use the source or ABI
behavior selected by their validated Runtime-HIR operation. A convenient Wasm
instruction is not permission to change overflow, bounds, NaN, evaluation-order,
or ownership semantics.

## 10. Correctness relation

Let `R_H` relate specialized Core configurations to Runtime-HIR configurations,
and `R_W` relate Runtime HIR to WebAssembly configurations.

Finite steps may be matched weakly:

```text
R(x, y)    x -> x'
-----------------------------
exists y'. y ->* y' and R(x', y')
```

This clause is necessary but not sufficient. Each relation also provides:

1. **stuttering control:** an empty target match decreases a well-founded rank;
2. **finite-outcome adequacy:** a related source return, request, or trap reaches
   the matching target observation after finitely many administrative steps;
3. **reflection:** every target return, request, or trap is matched by the source;
4. **protocol correspondence:** related host responses resume related one-shot
   continuations; and
5. **divergence adequacy:** demanded infinite execution is not replaced by a
   finite unrelated target outcome, nor manufactured by infinite administrative
   stuttering.

A progress-sensitive weak bisimulation is an equivalent proof form.

For a closed accepted program, validated adapters, and related conforming host
responses, composition of `R_H`, `R_W`, and the public representation relation
preserves and reflects returns, requests, specified traps, malformed-boundary
traps, and divergence.

## 11. Target refusal versus invariant failure

`TargetRefusal` is allowed when the selected, explicitly documented policy does
not admit a checked program, for example an unsupported public type or an
experimental feature not enabled for production.

It is not allowed to hide:

- an unresolved representation for a closed production-supported internal type;
- a certificate the compiler previously claimed to produce;
- a missing required adapter check for a boundary the compiler accepted;
- a private capability that leaked past specialization; or
- a target-only observation introduced by emission.

Those are invariant failures.

## 12. Obligations

The runtime boundary owes:

1. Runtime-HIR structural and representation validation;
2. exact replay of safety and ownership permission;
3. Store-write adequacy for persistent source operations;
4. total public-layout construction over the declared supported type set;
5. rejection of unsupported public layouts before emission;
6. validation of malformed caller inputs before source-value construction;
7. valid-value lift/lower round trips up to `~=`;
8. deterministic manifest and byte emission;
9. WebAssembly validation; and
10. progress-sensitive preservation and reflection of source observations.

Passing Wasm validation establishes target well-formedness, not source-language
correctness. ABI round trips, differential execution, and validation tests are
separate evidence for the obligations above.
