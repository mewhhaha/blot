# Runtime HIR and WebAssembly boundary

## Status and scope

This document owns:

- the admissible Runtime-HIR language;
- validation before emission;
- the semantic representation relation between source, Runtime HIR, and caller
  values;
- public-layout admissibility; and
- the Runtime-HIR-to-WebAssembly correctness obligation.

[`docs/abi.md`](../docs/abi.md) is normative for exact Core Wasm ABI 2 bytes,
canonical lifting/lowering encodings, and caller ownership. Its **Runtime target
status** section is operational and cannot weaken a rule for an artifact the
compiler accepts. Cross-document corrections are in
[`COHERENCE.md`](COHERENCE.md).

## WebAssembly target profile

The production default emits standard WebAssembly 3.0 instructions and is
continuously exercised on V8. The public ABI remains memory32; adopting the Wasm
3.0 specification does not silently change pointer width, canonical layouts, or
caller ownership.

Every manifest declares:

```text
coreSpecification    = "3.0"
requiredFeatures     = sorted exact validation features used by this artifact
optimizationFeatures = sorted semantically ignorable metadata emitted
```

The current emitter may require `bulk-memory`, `multi-value`, fixed-width
`simd`, and `tail-call`. It may additionally emit standardized `branch-hinting`
metadata. A host must validate the complete module and may use the
required-feature list for an earlier compatibility diagnostic. An optimization
feature can be ignored without changing source or ABI behavior; neither list
substitutes for WebAssembly validation.

An internal direct call in exact tail position lowers to `return_call` when the
callee and caller have the same flattened result layout. Exact tail position may
include a cycle-free chain of empty blocks that only rename the result before
the return; any operation or control decision ends the proof. This preserves
source returns, requests, traps, and divergence while discarding a target-only
caller frame. Public wrappers retain ordinary calls because canonical lifting,
lowering, call checkpoints, and post-return ownership must still execute.

A newer WebAssembly feature is enabled only when it either removes a compiler
transformation or has measured benefit and its source semantics are explicit.
Memory64, multiple memories, GC, typed function references, exception handling,
and relaxed SIMD are not baseline assumptions merely because V8 implements them.
Their admission requires a representation, determinism, ABI, ownership, and
fallback account.

The operational feature audit and engine matrix are recorded in
[`docs/wasm-target-profile.md`](../docs/wasm-target-profile.md).

## 1. Runtime-HIR boundary

Runtime HIR is the first artifact whose operations and representations are fully
target-facing. It is constructed only after ordinary checking, safety analysis,
ownership checking, staging, and representation-closing specialization.

A Runtime-HIR module contains:

- first-order control-flow graphs;
- closed scalar and aggregate representations;
- a typed table of immutable static scalar Stores;
- explicit calls and host requests with normalized input/result ownership;
- explicit Store literal, allocation, read, write, root, and release operations;
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
- private capability object crossing ABI 2.

During construction, a recursive result may temporarily have a private indirect
identity before a finite branch determines its target representation. The
producer tracks whether that identity is settled independently of the numeric
target identifier, because identifier zero is the ordinary `Unit`
representation. Every published module contains only settled indirect types;
missing or conflicting settlement is a compiler invariant failure rather than a
Runtime-HIR state accepted by validation.

### 1.1 Development links

A development Runtime-HIR module may contain `links` after whole-program
specialization has closed every representation. Each link names a provider unit,
a stable compiler-generated export name, and one existing closed signature. A
`call.external` operation names that link instead of a local function.
Production Runtime HIR has no links.

Splitting preserves the original direct-call observation. The provider wrapper
executes the same residual function, and the consumer observes the same return,
host request, specified trap, or divergence. Link arguments and results use only
the ABI-admissible first-order subset. A function value, Scratch,
compiler-private indirection, continuation, vector, mask, capability value, or
open representation at the boundary is a `TargetRefusal` before unit emission.

Each emitted unit owns one memory. The runtime bridge canonically lowers a
consumer value, copies its complete nested representation into provider memory,
calls the provider, then copies the result into consumer memory. Parameter
copies are borrowed for that synchronous call; the provider result is released
with its declared post-return function after copying. Source arrays, text, and
nested aggregates never share backing storage across unit memories. Replacing a
unit therefore resets only that unit's runtime state and cannot invalidate an
alias retained by another unit.

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
6. destructive Store operations name ownership permission for the exact consumed
   path and source occurrence;
7. Store/root lineage is not duplicated, forged, or crossed between families;
8. every capability operation has one closed input type, one closed result type,
   and an exact normalized ownership contract whose structural fields match
   those types;
9. every public or development-link boundary has an admissible closed source
   type and adapter policy;
10. no compile-time or proof-only value remains; and
11. every target feature used is admitted by the selected production policy.

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

Computed record fields do not cross this boundary with a dynamic key. Partial
evaluation resolves each key to text and applies the leading-spread
`RecordUpdate` relationship before specialization publishes a nominal record. A
computed key or open record relationship remaining after successful checking is
an invariant failure, not a Runtime-HIR feature or backend inference case.

The target write is related to construction of a fresh source result. It does
not retroactively make source aliases mutable.

A closed residual array construction is one `store.literal` operation. A dynamic
literal's operands have the Store's checked element representation and remain in
source order. Runtime-HIR schema 9 may instead name one entry in the module's
typed static-Store table and carry no operands. Normalization uses that form for
scalar constants and interns equal element type and value sequences across
residual functions and exports. Emission places each table entry in immutable
static data. Other element representations allocate once and write each operand
once; the emitter must not reconstruct either form as a chain of persistent
Store grows. An owned update of a pooled Store first copies it into private heap
storage, so sharing static bytes cannot make either source array mutable.

A residual array literal remains a static `Array` value until its first runtime
spread. At that boundary the producer materializes the static prefix as a fresh
Store, then appends the spread operand with a `store.length` / `store.read` /
`store.grow` loop. Later elements and spreads append to the produced Store in
source order; empty spreads perform zero loop iterations. Every grow is
persistent unless a separate ownership certificate grants destructive reuse, so
none of the spread operands is mutated. The typechecker has already proved a
single closed element representation. Residual evaluation retains that fact when
a staged array passes through aliases or polymorphic calls, and constructs each
element against it; in particular, a constructor member is injected into the
checked closed sum instead of defining a one-constructor Store from the first
element. A mismatch while constructing these operations is an
`InvariantFailure`.

Dynamic cases over integers and closed sums lower to a `switch` terminator in
Runtime HIR schema 6. Its selector is a closed `integer-32` or
`signed-integer-64`, its cases contain unique constants and parameter-free arm
targets, and its fallback names the wildcard or final closed-sum arm. Sum
lowering reads the constructor index once and projects a payload only inside the
selected block. Surviving arms branch to one join whose parameter uses the
checked result representation; trapping arms terminate without manufacturing a
value. Residual Boolean branches follow the same rule: a compiler-local
impossible arm becomes a trap terminator, and the surviving arm supplies the
join value. This preserves the left-to-right demand probes emitted for a
multi-subject case without evaluating a subject the selected row does not
demand. Compiler-local control envelopes may merge disjoint single-constructor
representations into the closed constructor set already established by surface
lowering. Dense `integer-32` switches emit `br_table`; other switches emit a
balanced comparison tree.

A non-reconvergent acyclic function emits as direct structured Wasm without a
program-counter local or dispatch loop. The same bounded structural expansion
emits an entry-recursive cycle as one Wasm loop. Switches, non-entry cycles,
reconvergent control flow, and graphs beyond the fixed expansion budget retain
the indexed dispatcher; the emitter does not duplicate a shared join to force
structure.

Every `call.direct` target receives an internal callable Wasm body even when the
same normalized Runtime-HIR function also backs a public export wrapper. The
wrapper remains separate because it owns canonical ABI lifting and lowering.

When every predecessor constructs a known member of that closed sum and no other
reader observes the joined sum, Runtime-HIR simplification may bypass the tag
switch. Each predecessor branches directly to the matching arm and passes the
constructor payload as an arm parameter. The source case remains a switch when
an arm is shared, an incoming edge is indirect, or another operation reads the
sum.

Borrowed reads never grant Store ownership. Splits and joins consume exact
family, root, footprint, and produced-value lineage. Equal-looking intervals or
roots are not interchangeable.

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
carrier. ABI 2 may lower it transparently to the carrier representation, while
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

The manifest includes ABI version, imports, exports, closed public types, export
ownership policy, exact host-operation input/result ownership, seal names where
relevant, and every representation parameter needed by a conforming adapter.

Host-operation ownership is a source-value protocol, separate from canonical
memory ownership. A synchronous import borrows its parameter memory for the
call. Its normalized contract may additionally transfer a logical affine or
linear input authority to the host or return a fresh obligation to the module.
Related source, Runtime-HIR, and WebAssembly requests agree on both the value
and that protocol.

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

The emitter may mark an `if` as likely false when its taken arm immediately
executes `unreachable`. This branch hint is target metadata, not a source fact
or validator premise. Removing it or ignoring it preserves the module's
observations. Ordinary conditionals and non-trapping branches receive no
synthetic probability.

Integer arithmetic, memory operations, and host calls use the source or ABI
behavior selected by their validated Runtime-HIR operation. A convenient Wasm
instruction is not permission to change overflow, bounds, NaN, evaluation-order,
or ownership semantics.

The private allocator stores capacity immediately before each returned heap
pointer. Fresh nonempty allocations reserve at least 16 bytes, and authorized
growth doubles capacity until it covers the requested size. Growth at the heap
cursor extends in place; other growth moves and copies only when capacity is
exhausted. The capacity word is backend-private and does not change the Store,
canonical ABI, or `cabi_realloc` pointer contract.

The emitter interns equal physical WebAssembly function signatures. Within one
function it derives Runtime-HIR block liveness, assigns identical flattened
representations to the same local tuple only when their live ranges do not
interfere, and emits adjacent equal local types as counted declarations. These
are physical layout choices over validated values, not another type judgment.
ABI closure computes each directly demanded flattened Runtime-HIR representation
once, including demanded product-field starting offsets. A type used only
through an indirect representation remains unflattened. Function emission
indexes validated SSA value types once. Projection, assignment, direct-call, and
local-allocation emission consume these indexes rather than rescanning earlier
product fields or function definitions.

A structured entry loop may use an iteration allocation region only when each
owned entry parameter is carried across every entry backedge as the exact same
Runtime-HIR value. The function saves the private heap cursor before the loop
and restores it on each such backedge after branch arguments have been assigned.
Replacing an owned parameter disables the region because the new value may
retain an iteration allocation. Plain scalar parameters may vary. Returns and
exits do not restore the cursor, so returned values remain live.

Store and Scratch elements use a private memory layout distinct from public ABI
layout. Fixed-width SIMD vectors and masks occupy 16-byte-aligned, 16-byte slots
and are transferred with `v128.load` and `v128.store`; this private layout does
not admit a vector at an export or host-effect boundary.

Runtime-HIR schema 6 represents a float shuffle with two vector operands
followed by four dominating `integer-32` constant operands in `0..7`. Emission
expands each float-lane selector to four byte selectors for one `i8x16.shuffle`
instruction. Float masks reduce with `i32x4.all_true` and `v128.any_true`;
integer vector operations select the matching 32-, 16-, or 8-bit SIMD opcode.

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
2. **finite-outcome adequacy:** a related source return, request, or trap
   reaches the matching target observation after finitely many administrative
   steps;
3. **reflection:** every target return, request, or trap is matched by the
   source;
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
