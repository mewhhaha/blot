# Compiler correctness obligations

## Status and scope

This document owns the proof structure connecting accepted source to emitted
WebAssembly. Exact source rules live in [`LANGUAGE.md`](../LANGUAGE.md) and the
focused specifications, subject to [`COHERENCE.md`](COHERENCE.md).

The compiler theorem is observational and conditional. It does not claim that
all programs terminate, that every host behaves, that every target policy admits
every checked type, or that the current implementation has mechanized every
lemma named here.

## 1. Artifacts and relations

Write the successful pass graph schematically as:

```text
source
  parse/elaborate-> Core
  demand-> Live Core
  type/effect-> Typed Core
  safety/ownership-> Certified Core
  stage-> Residual Core
  specialize-> Runtime HIR
  validate/abi/lower-> WebAssembly
```

For every adjacent artifact pair, the compiler defines a relation:

```text
R_frontend
R_demand
R_check
R_stage
R_specialize
R_hir
R_wasm
R_abi,A
```

A relation hides only the administrative identities and representation choices
explicitly declared private at that boundary. It cannot hide a return, request,
specified trap, demanded divergence, public ownership obligation, or malformed
boundary behavior.

## 2. Observations

Finite source observations are:

```text
Return(v)
Request(ell, operation, argument, continuation-protocol)
Trap(specified-trap)
```

Divergence is an infinite maximal execution. Public target execution may also
produce a versioned malformed-input or ownership trap before constructing a
source value.

A related host interaction agrees on the declared capability identity,
operation, and related argument. Related host responses resume related one-shot
continuations. Raw target continuation addresses are not compared.

Private allocations, Store headers, administrative blocks, closure indices,
target-local tags, and proof-erased values are not observations.

## 3. Frontend correctness

The frontend owes:

1. deterministic lexing and compact parsing for fixed source and language plan;
2. equivalence between incremental and fresh frontend results;
3. deterministic folding under the source syntax-prelude and module overlay;
4. rejection of duplicate fixities and coherent source overrides;
5. hygienic resolution and generated binders;
6. explicit `do:` control-target preservation, with declaration-directed phase;
7. source-origin preservation; and
8. typing and operational correspondence of surface elaboration.

A later pass consumes resolved identities and Core nodes. It does not repeat
parsing, name lookup, layout interpretation, or operator grouping.

## 4. Demand correctness

Let `L = live(block,result)` be the lexical dependency judgment. Dead pure
declarations are absent from source evaluation. The erasure theorem is:

```text
observe(block) = observe(erase_dead(block,L))
```

for returns, requests, specified traps, and divergence of the demanded program.
The liveness input is fixed before optimization.

Ownership is checked over the demanded artifact. A consuming action erased with
a dead declaration cannot discharge a linear obligation. The demand relation
therefore includes compatibility with the later ownership derivation, not only
value observations.

## 5. Source type-and-effect safety

Preservation is stated over a world that may extend with fresh immutable value
identities, effect atoms, module instances, continuation states, and Store
roots:

```text
W ; Gamma ; Phi ; Omega |- c : A ! epsilon
c -> c'
------------------------------------------------ preservation
exists W' >= W, Gamma', Phi', Omega'.
  W' ; Gamma' ; Phi' ; Omega' |- c' : A ! epsilon
```

The extension relation preserves all stable-identity and ownership invariants.
Reduction cannot change the promised return type or introduce an unaccounted
effect atom.

One-step progress for a closed well-typed computation says it is:

- a return;
- able to reduce;
- poised to request an operation whose atom is in its row; or
- at a specified source trap.

It is not stuck on a missing case, forged proof, invalid internal field, second
continuation use, or unclassified state.

Divergence is excluded from the one-step alternatives. The maximal-execution
theorem says every maximal execution reaches a classified finite outcome or
contains infinitely many reductions.

## 6. Application adequacy

Every function application is a Core computation. Its effect row may be empty,
but the computation may still return, trap, or diverge.

Frontend elaboration, inference, staging, specialization, and target lowering
all use the same application schedule. No pass may:

- reinterpret an empty-row call through a second pure evaluator;
- reorder it using effect emptiness as a totality proof;
- apply an already applied computation a second time; or
- duplicate a deferred argument whose contract permits one demand.

The application relation preserves function-before-argument order and the
callee's effect row.

## 7. Coverage and relationship safety

### 7.1 Coverage

If a closed match is accepted as exhaustive, every source value of the scrutinee
type selects an arm. Guards contribute coverage only for the subset justified by
a representable proved proposition. An explicit panic arm is a specified trap,
not missing-match stuckness.

### 7.2 Relationship certificates

For every proof-required operation, the validator reconstructs the exact
proposition from stable value and occurrence identities and checks entailment:

```text
certificate(op_id, premise_ids) valid
--------------------------------------
operation premise holds at op_id
```

A certificate copied to another operation, source revision, module instance, or
identity-changing rebind is rejected.

Removing a target check is sound only after this independent replay. The
producer cannot make its own conclusion an axiom.

## 8. Ownership safety

Ownership is mode-indexed:

```text
U  unrestricted: arbitrary use
B  borrowed: inspect only; no move or escape
A  affine: at most one consuming use; discard allowed
L  linear: exactly one consuming action on every terminating exit
```

The theorem is therefore:

- no tracked path is consumed twice;
- no path is consumed through a borrow;
- a borrow does not escape its admitted lexical boundary;
- affine paths are not duplicated, although they may be discarded;
- linear paths are accounted for exactly once on every terminating exit;
- closures and aggregates preserve the obligations of captured or contained
  paths; and
- a function's callback summary bounds every dynamic invocation of owned
  arguments.

This is not the blanket statement that no tracked obligation is ever lost.
Affine discard is intentional. It is also not a finalization theorem:
`Continuation.cancel` and another consuming destructor account for structural
use but run a domain-specific finalizer only when that operation's own contract
says so.

### 8.1 Reuse adequacy

A destructive Runtime-HIR operation is permitted only for the exact source
occurrence whose replayed ownership certificate proves unique consuming use and
complete path accounting.

The adequacy theorem relates that target mutation to the fresh persistent source
result. Syntactic last occurrence, source immutability alone, or a matching
Store shape is not sufficient evidence.

### 8.2 Partitioned authority

A split preserves family, root, exact cover, separation, and ownership payload.
A join consumes the exact factorization witness and exact children.

For partial composition, associativity requires only equal results when both
bracketings are defined. Reassociation is a checked operation, not a universal
proof-tree normalization. A family validator may reject a rotation whose target
intermediate composition is undefined.

## 9. Staging correctness

### 9.1 Phase safety

Residual code is closed over compile-time bindings. Replacing an erased
compile-time value while holding its generated residual artifact fixed cannot
change run-time observations.

This theorem includes checked bridge use and correct identity policy:

- ordinary source effects are generative under complete module-instance
  occurrence identity; and
- seals are applicative in public name and canonical invariant carrier.

### 9.2 Limit diagnostics

A deterministic compiler resource limit is not a source observation and does not
establish that the source judgment fails. The correctness theorem applies to
successful compilation and separately classifies `LimitDiagnostic` as no result,
not as a source trap or invalid program.

### 9.3 Specialization and representation closure

Specialization produces closed Runtime HIR. Every residual quantified use,
structural shape, effect representation, closure environment, branch join, Store
element, and public boundary has one target-admissible representation.

Failure to close a production-supported internal representation after successful
checking is an `InvariantFailure`. A type outside an explicitly documented
public or experimental target policy may produce `TargetRefusal` before
emission.

## 10. Pass simulation is progress-sensitive

For a pass relation `R`, finite source steps may be matched weakly:

```text
R(x,y)    x -> x'
-----------------------------
exists y'. y ->* y' and R(x',y')
```

Weak forward simulation alone is insufficient. A target could otherwise stutter
forever while matching every source step with zero target steps, or introduce a
finite target-only outcome not constrained by the source.

Each pass therefore supplies one of these equivalent packages:

- a progress-sensitive weak bisimulation; or
- weak forward simulation plus all conditions below.

Required conditions are:

1. **well-founded stuttering:** an empty target match strictly decreases a rank;
2. **finite-outcome adequacy:** a related source return, request, or trap
   reaches the matching target observation after finitely many administrative
   steps;
3. **reflection:** every target return, request, or trap is matched by a source
   execution;
4. **protocol correspondence:** related requests and host responses resume
   related continuations; and
5. **divergence adequacy:** demanded source divergence is not collapsed into a
   finite unrelated target result, and target divergence is not merely infinite
   administrative stuttering over a finite source execution.

Administrative reductions and private allocations may be hidden only under this
progress discipline.

## 11. Runtime-HIR validation

Runtime-HIR validation independently checks:

- closed representation at every operation and edge;
- complete control-flow and call metadata;
- proof and ownership certificates for exact occurrences;
- Store/root lineage and family identity;
- absence of compile-time and proof-only values;
- target-policy admission; and
- complete public layout metadata.

A producer success followed by a validator failure is an invariant failure. The
validator is not another source typechecker and cannot reinterpret source names
or syntax.

## 12. Public ABI adequacy

For every admitted closed public type `A`, adapters satisfy:

```text
lift_A(lower_A(v)) ~= v
```

for valid source values, with `~=` hiding private allocation identity and
respecting canonical order.

Lifting validates malformed UTF-8, booleans, discriminants, pointers,
alignments, lengths, extents, and ownership state before constructing a source
value. If a required validation is unimplemented, public-layout construction
returns `TargetRefusal`; accepting an unchecked boundary is an invariant
failure.

A seal name is a manifest and conformance fact. Equal raw Core Wasm carrier
bytes do not dynamically enforce source nominality. The ABI theorem assumes a
caller that follows the declared manifest and ownership protocol.

A private Runtime-HIR root or capability with no ABI 2 relation must be refused
at public-layout construction. Reaching the emitter with such a boundary is an
invariant failure.

## 13. WebAssembly adequacy

Validated Runtime HIR lowers to WebAssembly accepted by the WebAssembly Core
validator. WebAssembly validation establishes target well-formedness, not source
correctness.

A target trap is permitted only when related to:

- a specified source trap; or
- a malformed public-boundary input or ownership violation required by the ABI.

A defensive internal check may remain only with proof that related valid states
cannot reach it. Reaching one is an invariant failure, not an additional target
outcome.

Arithmetic, memory, and host-call lowering preserve the behavior selected by the
validated Runtime-HIR operation rather than whichever target instruction is most
convenient.

## 14. Whole-compiler theorem

Let `G` be a complete resolved source graph, `tau` a target/ABI policy, `W` the
emitted WebAssembly module, `M` its canonical manifest, and `R_A` the public
representation relation for entry type `A`.

Assume:

1. compilation succeeds with no source or limit diagnostics;
2. the entry module is closed except for capabilities declared by `M`;
3. every pass relation and validation obligation above holds;
4. caller inputs are valid under `M`, while malformed inputs take the specified
   boundary trap;
5. the host follows the declared request/response and ownership protocol; and
6. the engine implements the WebAssembly Core specification.

Then source execution and WebAssembly execution preserve and reflect:

```text
returns related by R_A
host requests and related responses
specified source traps
specified malformed-boundary traps
divergence
```

Private administrative and allocation identities are erased by the composed
relation.

The theorem is conditional on successful compilation. `SourceDiagnostic`,
`LimitDiagnostic`, `TargetRefusal`, and `InvariantFailure` are classified
compiler results rather than extra source observations.

## 15. Determinism and incremental reuse

For fixed source graph, source syntax-prelude revision, dependency revisions,
compiler and certificate schema, primitive catalog, target policy, and
documented resource bounds, compilation is deterministic, including ordered
diagnostics and artifact bytes.

Incremental compilation is memoization of this same judgment. A cached artifact
may be reused only when every input observed by its phase is equal and its
closed certificate validates against the current artifact identities. Reuse
cannot merge distinct module instances, effect occurrences, Stores, or source
revisions.

A cache hit and a fresh run must produce equivalent diagnostics or artifacts;
performance is the only intended difference.

## 16. Evidence and formalization

Evidence should be layered:

- parser and elaboration fixtures;
- demand and application regressions;
- type, effect, coverage, relationship, and ownership tests;
- certificate mutation and replay tests;
- specialization and Runtime-HIR validation tests;
- source/Rust/Wasm differential execution;
- ABI malformed-input and round-trip suites;
- capability-family generated law tests; and
- mechanized lemmas for stable Core fragments.

A theorem about the current Lean seed calculus does not establish production
parser, module, reflection, ownership, SIMD, specialization, Runtime-HIR, or ABI
correctness until a checked artifact correspondence connects them.

The trusted computing base is reduced only when validators reconstruct premises
rather than trusting producer claims, and when each translation to a mechanized
model is itself specified and checked.
