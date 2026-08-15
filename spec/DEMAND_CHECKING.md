# Demand-driven checker work

This document refines the representation obligations in
[`TYPECHECKING.md`](TYPECHECKING.md) and the work model in
[`COST_MODEL.md`](COST_MODEL.md). It changes no typing judgment. It specifies
when the readable Node checker may delay or memoize work that the declarative
checker has already determined.

## 1. Record-scheme instantiation

Let a generalized immutable record be

```txt
R = { l_i : A_i }.
```

Eager instantiation freshens every `A_i` through one memo table `M`. A demanded
representation may retain `R` and `M` and define

```txt
fresh_field(R, M, l_i) = fresh_M(A_i).
```

For every deterministic sequence of observed labels, this returns types
alpha-equivalent to the corresponding fields of eager instantiation. The shared
memo is essential: if one generalized variable occurs in two demanded fields,
both fields must observe the same fresh copy within that instantiation. If all
fields are eventually observed, the complete result is alpha-equivalent to the
eager record.

The proof is induction on field observations. First observation runs the same
freshening rule and records the copy in `M`; later observations reuse it.
Unobserved fields contribute no source observation. Fresh identity allocation
may happen in a different order, but those identities are internal and source
traversal still fixes a deterministic demand order.

## 2. Suspended record lower bounds

Width subtyping can produce

```txt
{ ..., l : A, ... } <= { l : beta }
```

where `beta` is fresh and has no lower or upper bounds. Eager checking records
`A <= beta`. The implementation may instead retain `(fields, l)` as a suspended
lower bound when all of these hold:

1. field membership is checked immediately, preserving missing-field errors;
2. `beta` has no upper bound, so the lower bound cannot yet propagate;
3. the suspended field is materialized before `beta` is freshened, before its
   lower side is extruded, or before an upper bound is inserted; and
4. speculative right-union candidates remain eager unless suspended-state
   mutation is added to the same rollback journal.

Before materialization, the eager and suspended states are observationally
equivalent because adding a lower bound to a fresh variable with no upper bound
cannot fail or emit another constraint. At the first operation that can observe
or propagate the lower set, materialization inserts exactly the eager field type
and ordinary propagation resumes.

This is the TypeScript counterpart of the open-frame principle in
`TYPECHECKING.md`: opening a large immutable module must not recursively copy
all exported field types merely to establish names that source never uses.

## 3. AST-local memoization

For an immutable AST node `n`, a query `Q(n)` may be memoized by exact object
identity when its result depends only on syntax reachable from `n`. Examples are
free names, pinned names, pattern-bound names, and import/include-site discovery.
The result contains no inference variable, evaluator state, file content outside
the node, or target fact.

The loader preserves AST identity for an unchanged module and replaces it on a
new source revision. Therefore this memoization removes repeated structural
traversal without becoming a semantic cache or crossing a revision boundary.

## 4. Implementation obligations

The Node implementation therefore keeps one freshening memo per record-scheme
instantiation, uses lazy record field views, suspends only inert
record-to-fresh-variable lower bounds outside speculative union candidates, and
memoizes syntax-only name queries with `WeakMap` keys.

Executable evidence must include:

- zero field freshening when a record scheme is instantiated but no field is
  observed;
- one demanded field materializing without freshening an unused sibling;
- repeated observation returning the same field copy within one instantiation;
- polymorphic fields opened into scope still instantiating independently per
  use; and
- same-node AST queries returning the same immutable cached result.

Any optimization that reuses mutable inference bounds, settled dependency facts,
or evaluator state is outside this document and must satisfy the certified cache
rules in [`INCREMENTAL.md`](INCREMENTAL.md).
