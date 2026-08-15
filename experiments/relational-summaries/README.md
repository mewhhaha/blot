# Relational summary experiment

Status: experiment. Nothing here is source syntax or a compiler contract.

This experiment tests the boundary sketched in
[The facts live beside the values](https://stillbrook.dev/articles/the-facts-live-beside-the-values):
can a function transport facts beside its ordinary values without putting those
facts in the value-type lattice? It uses the existing affine
difference-constraint solver from `src/core/refinement.ts`; it does not
introduce another proposition language.

The motivating shape is an internal form of:

```text
readExact(input, count) -> bytes
ensures length(bytes) = count
```

The source language does not gain `requires`, `ensures`, `fact`, `needs`, or
`gives`. A future surface form is justified only after the internal boundary is
small, compositional, and independently checkable.

## Model

A relational summary names only abstract parameter and result slots. At a call:

1. parameter slots are substituted with the caller's immutable value identities;
2. every precondition is checked against the caller's current `Phi`;
3. result slots either receive fresh identities or explicitly alias a parameter;
4. postconditions are substituted with those identities and added to `Phi`; and
5. the function's local fact graph is discarded.

The published boundary contains the slot summary and nothing else. Concrete
`ValueId`s, solver state, local facts, and source spans cannot cross it.

A rebinding models the article's fact lifetime without adding assignment to
Blot. It creates a fresh value identity, removes every fact incident to the old
identity, and records both where each fact came from and which rebinding
invalidated it. A failed proof may then explain that the needed fact was known
at one operation and forgotten at another.

An explicit alias result is the first, deliberately tiny frame rule. A known
identity function may return its parameter's identity and therefore preserve
facts automatically. An unknown or relation-opaque result receives a fresh
identity and inherits nothing.

## Invariants

- Ordinary types and algebraic subtyping are absent from this experiment.
- Preconditions may mention parameters only; results do not exist yet.
- A failed precondition neither allocates result identities nor changes `Phi`.
- Published summaries contain slot indices, never concrete identities.
- Loading rejects malformed slots and non-canonical numeric constants.
- Rebinding invalidates only facts incident to the replaced identity.
- Postconditions use the existing decidable affine proposition fragment.

## Questions exercised

- Can one summary instantiate independently at unrelated call sites?
- Can a result preserve a fact only through an explicit identity alias?
- Can the interface forget every local fact while retaining the public summary?
- Can a missing-fact diagnostic identify both proof origin and invalidation
  site?
- Can all of this reuse the current refinement kernel unchanged?

## Non-goals

- source syntax for named facts or contracts;
- arbitrary predicates, quantifiers, `min`, or collection-specific theories;
- inference of relational summaries from function bodies;
- a general higher-order frame rule;
- module-interface or production-checker integration; and
- changing which Blot programs are accepted.

Promotion requires a concrete source program that current proof-producing
operations cannot express cleanly. Until then, this experiment is evidence about
the boundary, not a language proposal.

## Result

The focused tests pass against the production refinement kernel without changing
it. They establish that:

- one slot summary instantiates independently at unrelated call sites;
- precondition refusal is transactional, including identity allocation;
- direct identity aliases preserve facts while opaque results do not;
- canonical publication is independent of conjunction order;
- the loader rejects result-dependent preconditions, invalid aliases, and
  non-canonical integers;
- a rebinding can retain the origin and invalidation site of a missing fact; and
- an alias that still names the old immutable value keeps its facts live.

The experiment also exposes the remaining costs. The solver intentionally knows
nothing about names such as `Sized`; such a name would have to expand to this
existing proposition fragment. A direct result alias is not a general
higher-order or structural frame rule. Diagnostic provenance lives beside the
solver because `RefinementContext` correctly stores logical assumptions rather
than source history. Body-side summary verification and module-interface
integration remain untested.

The result supports an internal relational-summary representation, not new
syntax. The next justified step would be one real compiler-owned operation whose
wrapper currently loses a useful affine fact. Its body or trusted primitive
contract must produce the summary, and the importing caller must consume a
validated slot-only encoding. Without that program, this directory should remain
an experiment.
