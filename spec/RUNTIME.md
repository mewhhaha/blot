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
