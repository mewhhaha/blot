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
5. every destructive Store operation carries ownership permission;
6. every private Region operation carries checked authority and uses one
   Store-plus-bounds representation;
7. every private recursive root was authorized by a checked closure-SCC
   certificate and has a finite constructor case;
8. every private function-choice table has at least one alternative, one case
   per alternative, and one capture product per case; and
9. every export and import is admitted by the selected ABI policy.

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
those captures is dynamic; wholly static recursion may still be evaluated. Tail
position is not an admission requirement. It permits the later back-edge
rewrite, while a non-tail self-call remains `call.direct`. Development and
production lowering must agree on the specialized argument, result, capture, and
effect representations before either form reaches Runtime-HIR validation.

A dynamic branch whose arms produce functions has no single closure to convert,
so the join defunctionalizes them. Every reachable arm normalizes to one
alternative: a lambda's module and body with the environment it closed in, or a
partially applied primitive with the arguments it already holds, together with
that arm's ordered runtime captures. The joined value is a private sum whose
case selects an alternative and whose payload is that alternative's capture
product. Two arms share a case only when they name the same source _and_ the
same closed environment or equal already-applied arguments: a captured
compile-time value is part of what a function means, so two closures over one
body may not be merged on the body alone. An arm that is already such a choice
contributes the alternatives it carries, so nested choices flatten into one
finite table rather than nesting.

One case's payload occupies the sum's payload slots from the first one on, so
alternatives whose capture products are prefixes of the widest are carried
directly. When they are not — an `Int` captured in one arm and an `F64` in
another — every case carries a private indirection to its capture product
instead, which is one slot whatever it points at.

At application the choice dispatches on its tag, projects the payload back into
the alternative's captures, and applies the selected function, so each call site
specializes for the argument representation it supplies. `n` alternatives cost
`n - 1` tests: the last needs none.

The table is Runtime HIR's own bookkeeping. Its cases name compiler-local
closure sources, so ABI 1 refuses it at any public boundary with a diagnostic
that names the private layout. A branch that joins a function with a value that
is neither a lambda, a partially applied primitive, nor another choice has an
open source set; that refusal reports the offending value and the signature the
checker inferred for the function. A closed source set must compile.

Staged non-empty arrays become ordinary Store construction. Store memory uses
the canonical scalar layout internally as well as at adapters, so reads and
writes preserve `i64`, `f32`, and `f64` element representations rather than
reinterpreting an unconstrained element as `Unit`.

Persistent array decomposition is a residual operation, not a staging-only
convenience. `@array.take` and `@array.split` are saturated direct operations
whose array-index certificate proves `0 <= index < length(array)` before Runtime
HIR. When the array or index is dynamic, they lower to ordinary Runtime-HIR
control flow over `store.length`, `store.read`, `store.empty`, and persistent
`store.grow`, but no bounds-failure edge or result tag remains. The selected
element is read once and every retained element is copied once, in source order,
into one remainder Store for `take` or the two contiguous result Stores for
`split`. The source ownership certificate has already partitioned element
obligations; Runtime HIR preserves that tuple shape but carries no second
ownership or refinement calculus.

No `uncons`, partition, or quicksort operation is admitted at this boundary.
`Array.uncons` remains the total prelude branch that proves index zero before
calling `@array.take`, and `Array.partition` remains an ordinary fold.
Type-directed residualization must therefore retain the settled element
representation of polymorphic empty Stores and closed constructor joins even
when their first runtime inhabitant is produced only inside a recursive call. A
well-typed first-order collection program may not be made compilable by
replacing its dynamic input with a staged constant.

A residual Region is one compiler-private product of a Store, inclusive start,
and exclusive end. `claim` reuses only a fresh Store whose binding ownership
proves it unavailable elsewhere; a shared or unknown Store receives one
persistent copy before authority is minted. Relative reads and writes add the
start only after proving the relative index inside `[0,end-start)`. `split`
branches on the relative offset and returns either two products over the same
Store or the unchanged parent. The ownership pass has already checked the linear
recombination witness, so `join` erases that witness and rebuilds the parent
bounds. `freeze` erases a complete root product to its Store. Region products
and live witnesses are private layouts and are refused at ABI 1.

`replace` performs the same relative bounds proof as `set`, reads the displaced
slot, writes the replacement only on the success edge, and returns both the old
value and unchanged region product. Its failure edge returns the replacement and
unchanged region without a write. The ownership certificate, not Runtime HIR,
carries positional element obligations. Witness reassociation is validated
before Runtime HIR and is erased completely: it performs no Store access,
allocation, or emitted instruction.

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

The executable acceptance boundary for persistent decomposition includes:

- host-dynamic, proof-refined `@array.take` and `@array.split` calls with plain
  tuple results, plus rejection of unproved and statically out-of-bounds calls;
- a host-dynamic `Array.uncons` / `Array.partition` / `<>` quicksort whose full
  output agrees in the evaluator and emitted Wasm;
- Runtime-HIR inspection proving the sort remains ordinary Store/control-flow
  code rather than a collection-specific operation; and
- Node development and Rust production acceptance parity for the same source.

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
