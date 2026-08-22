# Safety analyses and certificates

## 1. Separation from inference

Coverage, relational facts, and ownership consume inferred types without adding
constructors to the type lattice. The combined judgment is summarized as

```text
Gamma ; K ; Phi ; R ; Omega |- e : A ! E ; C
```

where `Gamma |- e : A ! E` is ordinary inference, `Phi` is a proposition
context, `R` assigns stable value identities, `Omega` tracks ownership paths,
and `C` is finite erasable evidence. Erasing `Phi`, `R`, `Omega`, and `C` leaves
the same principal ordinary type.

## 2. Coverage

Coverage is set subtraction over the finite part of the scrutinee domain.
Constructor unions, booleans, finite integer ranges, tuple products, and nested
patterns contribute finite spaces. Open or unlistable domains require an
irrefutable arm.

For rows `p1 ... pn`, acceptance establishes

```text
domain(A) \ covered(p1 ... pn) = empty
```

or records that the final row is irrefutable. Guards subtract only what their
proved proposition entails. A failed value conditional does not transfer control
to an enclosing function; statement-control elaboration expresses that transfer
before coverage runs.

## 3. Relationships

Relational propositions are outside types:

```text
Phi ::= t = u | t < u | t <= u
```

Array creation assigns a stable `ValueId`; a transparent alias preserves it and
a new construction, rebinding, or unknown result replaces it. A direct array
access requires a replayable derivation of

```text
0 <= i and i < len(a)
```

whose certificate names both the array and index identities. Total access
returns the source-level optional result and needs no proof. Immutable array
length makes a verified certificate stable until either identity changes.

The refinement solver may grow more expressive without changing ordinary
subtyping. Failure to prove a true proposition rejects only the proof-requiring
operation; it does not license an unchecked lowering.

## 4. Ownership

Ownership is a flow analysis over structural paths:

```text
Omega(path) = Live | Moved | Partial(children)
```

Moving a field changes that leaf and its ancestors. Whole-value use requires a
live root. Branch joins preserve exactly the paths live on every continuing
branch, and linear paths must have equal terminal consumption. Borrows preserve
the tree but cannot be used to recover or move an owning parent.

The no-double-move lemma and exact branch rules live in
[`TYPECHECKING.md`](TYPECHECKING.md). Destructive Store reuse is permitted only
by an ownership certificate for the final consuming update; source arrays remain
immutable whether or not the target reuses storage.

A `reuse fn` assertion is checked after those permissions exist. It rejects a
persistent Store update in the lambda's residual frame but cannot manufacture a
permission, reinterpret a last use as consumption, or change the inferred
function type. Materialized checked functions publish the discharged assertion
in Runtime-HIR schema 3 for independent validation.

Ownership certificate schema 3 publishes the checked-reuse assertion bit and
structural lineage. Each owning destination path names its earlier binding
identity and source path. Dynamic proof-refined `@array.take` lineage contains
exactly the selected and remainder parts; `@array.split` contains exactly the
prefix, selected, and suffix parts. The independent verifier rejects an unknown
source identity, malformed path, duplicate lineage, invalid part, or incomplete
partition. Bounds failure is not an ownership path: an unproved extraction is
rejected before lineage is minted.

## 5. Certificate discipline

A certificate contains:

```text
Certificate = (rule, conclusion, premises, sourceOrigin, revision)
```

The consumer checks the rule and premise identities independently. Copying a
certificate to another expression, using it after an identity-changing rebind,
or loading it under a different revision is invalid. Evidence is erased from
runtime values after it has authorized lowering. A certified direct array read
therefore needs no second target bounds decision; total source access still
performs its ordinary guard before reaching that read.

Certificate failure after a successful analysis is an invariant failure. Failure
to construct evidence from user source is a diagnostic at the source operation
that required it.

## 6. Safety theorem obligations

Accepted safety certificates establish:

- a closed `case` does not reach a missing arm;
- proved array operations do not reach an array-bounds trap;
- no ownership path is moved twice or moved through a borrow;
- affine obligations are consumed at most once;
- linear obligations are consumed exactly once on every terminating exit;
- every certified consuming extraction accounts for each output partition; and
- permitted target mutation is observationally equal to immutable source update.

Independent certificate replay, generated finite-domain coverage tests,
path-generated ownership tests, and three-execution agreement are evidence for
these obligations.
