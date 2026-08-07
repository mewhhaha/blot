# Runtime representation and lowering

## 1. Boundary

The runtime boundary begins after staging and specialization. Its input is a
closed program with settled types, explicit effects, safety evidence, and
ownership permissions. Its output is validated Blot Runtime HIR.

Blot owns Runtime HIR, its validator, ABI policy, the module shell, and direct
Rust/WebAssembly emission. Gpupaper is an independent conformance oracle and is
not part of the production runtime boundary.

## 2. Runtime HIR

Write

```text
Delta_rep ; C |- lower(e) => h : HType
```

where `Delta_rep` maps every residual binding to a concrete representation and
`C` is the certificate set. Runtime HIR validation establishes:

1. every operand and result has a closed monomorphic representation;
2. every projection and constructor names a complete structural layout;
3. every effect operation has a concrete capability, operation, and signature;
4. every proved operation carries valid evidence;
5. every destructive Store operation carries ownership permission; and
6. every export and import is admitted by the selected ABI policy.

Validation does not infer a missing source fact. A well-typed internal program
that reaches an open shape or polymorphic operation exposes a specialization or
lowering bug.

## 3. Closed program and public layout

Closing maps Runtime HIR and its public boundary to one artifact:

```text
close(h, tau) = ClosedProgram(h, PublicLayout(manifest, adapters))
```

Records, tuples, and variants receive deterministic layouts. Source effects
become explicit capabilities or specialized control. Canonical adapters surround
the private runtime representation. The manifest and adapters are projections of
the same `PublicLayout`; neither may independently infer field order, variant
tags, flattening, or post-return ownership.

Closing preserves evaluation order and host request order. It may erase types,
certificates, and compile-time fields only after their last compiler use.

## 4. Public representation relation

For every public source type `A`, ABI policy defines a relation

```text
R_A(sourceValue, callerValue, memory)
```

and partial boundary functions:

```text
lift_A  : caller representation -> Result(sourceValue, abiTrap)
lower_A : sourceValue -> caller representation + ownership obligation
```

For every valid public value:

```text
lift_A(lower_A(v)) = v
```

up to allocation identity and canonical ordering. Lifting validates pointers,
lengths, alignment, UTF-8, booleans, and discriminants before constructing a
source value. Lowering obeys post-return ownership. The exact layouts are
normative in [`docs/abi.md`](../docs/abi.md).

Private heap headers, internal tags, and object addresses never satisfy `R_A`
directly.

## 5. Emission

The direct Rust emitter consumes only validated Runtime HIR and its
`PublicLayout`. It deterministically produces a WebAssembly module.

For each validated Runtime-HIR step, emitted WebAssembly takes zero or more
administrative steps and reaches a related state. A target trap is permitted
only when it corresponds to a specified language trap, malformed ABI input, or
an unreachable defensive check. Integer arithmetic uses the source trapping or
wrapping rule chosen before Runtime HIR.

A residual recursive binding with a settled first-order signature is an ordinary
Runtime-HIR function connected by `call.direct`; exported first-order functions
use the same function bodies with canonical parameter and result adapters.
Closure conversion appends the binding's lexically free runtime values to the
function signature and to every direct call. Function identity includes the
argument representation, capture representations, and specialized source
signature. A recursive body is residualized when either its argument or one of
those captures is dynamic; wholly static recursion may still be evaluated.

Staged non-empty arrays become ordinary Store construction. Store memory uses
the canonical scalar layout internally as well as at adapters, so reads and
writes preserve `i64`, `f32`, and `f64` element representations rather than
reinterpreting an unconstrained element as `Unit`.

An owned-reuse Store growth receives the previous pointer and byte length. When
that allocation ends at the private heap cursor and still satisfies the
requested alignment, `cabi_realloc` extends it in place; otherwise it allocates
and copies. A persistent growth never supplies the previous allocation and
therefore cannot overwrite or extend storage observable through an older Store
value. Linear and affine consumption both justify owned reuse because neither
permits a second observation after the consuming occurrence. The public result
adapter checkpoints the private heap at entry and restores it after scalar
results or canonical post-return, so these internal allocations form a scratch
arena per outer export call.

Finite recursive structures may use the prelude `Arena`: nodes occupy a
homogeneous Store and contain stable integer indices to other nodes. This is a
typed indexed graph, not an ABI pointer. Safe lookup retains the Store bounds
proof, and the arena cannot escape through an index alone. Once the safety
certificate has been replayed, `store.read` omits a duplicate target bounds
decision. The total `Arena.get` path reaches that operation only after its
ordinary source guard succeeds. General recursive algebraic values still require
an explicit recursive Runtime-HIR representation; the indexed form does not
pretend to provide one.

A direct self-tail call may become a branch to the function entry block. The
returned value may pass only through block parameters, the compiler-private
early-return sum envelope, and product projection followed by exact
reconstruction; these operations neither trap nor perform effects. Any other
operation after the call prevents the rewrite. The call operands become entry
arguments and are assigned in parallel before the back-edge, so argument
permutations observe the same old parameter values as a call. Mutual recursion
and indirect calls remain calls.

An entry-cycle function may be emitted as one WebAssembly `loop` when treating
every edge to the entry as a back-edge leaves an acyclic reachable graph. The
emitter unfolds that graph into nested target conditionals, assigns entry
arguments in parallel, and emits each entry edge as `br`; returns remain
returns. A shared acyclic join may therefore be duplicated in the artifact, but
only the chosen branch executes it. Unfolding has an explicit block budget. A
non-entry cycle, an invalid target, or a graph over that budget retains the
block dispatcher. This criterion makes reducibility and code-size growth
explicit rather than relying on source syntax: recursive functions and desugared
`for` forms use the same rule.

Before that test, Runtime HIR may bypass representation-only control
round-trips. A conditional that materializes opposite booleans solely to branch
on the result becomes a direct conditional. Likewise, known sum constructors
that flow to one tag decision may branch directly to their matching payload
blocks when those blocks have no other predecessor. Constructor payloads become
block arguments. These rewrites do not duplicate or discard source operations,
effects, or traps; they remove only the constructor/tag/projection steps whose
outcome is already fixed.

The emitter may remove an empty block whose only terminator forwards its
parameters unchanged. Predecessors then target the forwarded block directly,
preserving arguments, branch choice, effects, traps, and source evaluation
order. This administrative simplification does not authorize folding a source
computation or discarding an ownership edge.

## 6. Runtime theorem obligations

Successful lowering and emission establish:

- Runtime HIR execution simulates specialized source execution;
- WebAssembly execution simulates Runtime HIR execution;
- public lifting rejects malformed representations before observation;
- public lowering and lifting round-trip valid values; and
- the sidecar and embedded manifest bytes are identical.

The reference evaluator, independent conformance evaluator, emitted Wasm corpus,
ABI round trips, and malformed-input tests are executable evidence. Current
implementation coverage and target restrictions remain operationally documented
in [`docs/backend.md`](../docs/backend.md).
