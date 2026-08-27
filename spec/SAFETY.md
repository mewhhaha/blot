# Safety analyses and certificates

## Status and scope

This document owns coverage, relational proof, ownership, and reusable safety
certificate judgments. Ordinary type inference is owned by
[`TYPECHECKING.md`](TYPECHECKING.md); source demand and Core observations are
owned by [`CORE_SEMANTICS.md`](CORE_SEMANTICS.md). Cross-document constraints
are in [`COHERENCE.md`](COHERENCE.md).

The analyses consume the demanded typed program. They do not add constructors to
the ordinary type lattice.

## 1. Combined judgment

Summarize the safety boundary as:

```text
Gamma ; K ; Phi ; R ; Omega |- c : A ! epsilon ; C
```

where:

- `Gamma` is the ordinary type environment;
- `K` contains compile-time facts available to checking;
- `Phi` is a duplicable proposition context;
- `R` maps bindings and expressions to stable immutable-value identities;
- `Omega` tracks mode-indexed ownership paths; and
- `C` is finite erasable evidence.

Erasing `Phi`, `R`, `Omega`, and `C` leaves the same ordinary type and effect
row. Relationships and ownership cannot be used as hidden subtype dimensions.

The input is the live Core artifact. A proof, move, cancellation, or destructor
inside an erased pure declaration is absent and cannot satisfy an obligation in
this judgment.

## 2. Coverage

Coverage is set subtraction over the representable portion of the scrutinee
domain. Constructor unions, booleans, finite integer ranges, products, and
nested patterns contribute finite spaces. An open or unlistable domain requires
an irrefutable arm.

For pattern rows `p_1 ... p_n`, acceptance establishes:

```text
domain(A) \ covered(p_1 ... p_n) = empty
```

or records that an arm is irrefutable.

Coverage is computed over the complete cross-product of pattern columns. A guard
covers only the subset entailed by its proved proposition. An arbitrary boolean
expression cannot be treated as unconditionally true because examples happen to
exercise it that way.

Statement control is elaborated before coverage. A failed statement condition
does not escape an enclosing function unless explicit Core control represents
that transfer.

The coverage theorem is:

```text
Gamma |- v : A    covers(A, arms)
----------------------------------
some arm matches v
```

An explicit panic in an irrefutable arm is a specified source trap, not a latent
missing-match state.

## 3. Relationship context

Relational propositions are outside ordinary types. The first solver admits a
decidable affine fragment such as:

```text
x = y
x = y + k
x < y
x <= y
0 <= i
i < length(alpha)
length(beta) = length(alpha) + k
InBounds(alpha,i)
```

`Phi` refers to stable immutable-value identities. An alias preserves identity;
a new construction, identity-changing rebind, unknown result, or module-instance
change produces another identity unless a checked summary establishes a precise
relation.

Failure to prove a true proposition is a conservative rejection of the
proof-required operation. It never licenses unchecked lowering.

The production affine solver admits at most 512 immutable terms and 2,048
directed difference edges in one module proof context. Once either bound is
reached it stops retaining new facts. A later proof-required operation reports
`BLOT_REFINEMENT_BUDGET` with remediation to split the proof into a verified
helper or shorten the set of simultaneously live affine facts; truncated facts
are never interpreted as proof.

## 4. Total and proof-required operations

A total array access performs the source bounds decision and returns the
source-level optional result. It requires no relationship certificate.

A direct access has a premise:

```text
Gamma ; Phi |- a : Array A
Gamma ; Phi |- i : Int
Phi entails 0 <= i < length(identity(a))
------------------------------------------------
Gamma ; Phi |- get_proved(a,i) : A
```

The certificate names:

- compiler and certificate schema;
- source revision;
- saturated operation identity;
- exact array and index value identities;
- normalized proposition; and
- every premise derivation or checked summary it uses.

A validator reconstructs the proposition independently. Copying evidence to
another occurrence, using it after an identity-changing rebind, loading it under
another revision, or substituting a matching printed name is invalid.

A successful direct-read certificate permits lowering without a second target
bounds branch. A total source operation still performs its ordinary source guard
before any proved read it reaches.

## 5. Ownership state

Ownership is a structural flow analysis. Each stable path has one mode and
state. Explanatory modes are:

```text
U  unrestricted: arbitrary use
B  borrowed: inspect only; no move or escape
A  affine: at most one consuming use; discard allowed
L  linear: exactly one consuming action on every terminating exit
```

A path state is conceptually:

```text
Live | Moved | Partial(children)
```

Moving a field changes that leaf and its ancestors. Whole-value use requires a
live root. Aggregates carry the joined obligations of their children, and
closures carry captured paths.

Branches begin with the same incoming ownership state. Continuing branch outputs
must agree for linear paths; affine joins are conservative and may discard a
path but cannot duplicate it. A borrow preserves the ownership tree but cannot
recover or move the owning parent, escape its lexical region, or cross the host
boundary.

A function publishes a type-independent ownership summary describing parameter,
callback, and result-path use. Passing a linear closure once to a function that
invokes it twice is a duplication and is rejected.

Each effect operation likewise publishes one normalized input summary and one
result summary. A direct arrow supplies unrestricted roots. A descriptor may use
unrestricted, affine, or linear roots, or exact recursive record/variant
summaries whose names match the operation type. Borrow is not an operation mode:
a request suspends the caller and cannot carry a lexical borrow across that
boundary.

Calling an operation applies the input summary as an ordinary function contract
and mints the result summary as a fresh obligation. A handler clause's argument
pattern must match the input summary exactly. An explicit owned handoff to its
one-shot `resume` must match the result summary exactly; an unrestricted resume
value requires no ownership promise. These summaries remain outside the ordinary
type and effect lattices.

Current linearity is a structural unique-use theorem. A consuming action runs a
domain-specific finalizer only when that operation's contract explicitly says
so. `Continuation.cancel` accounts for the continuation without executing the
discarded context.

## 6. Destructive reuse

Source arrays, records, and other persistent values remain immutable. A target
Store update is permitted only by an ownership certificate for the exact final
consuming source operation.

The certificate proves:

- unique consuming use at that occurrence;
- no source-observable alias remains live afterward;
- every contained owned path is transferred or consumed; and
- required relationship and representation facts hold.

Syntactic last occurrence, source immutability, or a matching Store shape cannot
manufacture this permission.

An `@[assert.reuse]` declaration tag is checked after permission exists. It may
reject a residual persistent Store update, but it cannot create ownership,
reinterpret a use as consuming, or change the inferred function type.

## 7. Partitioned authority

A split certificate records family, root, parent footprint, ordered children,
factorization event, and produced-value lineage. Every child is accounted for. A
join consumes the exact witness and exact child authorities.

Family validation establishes disjointness, exact cover, deterministic focus,
frame locality, and mode-indexed ownership conservation.

Partial composition is not assumed to have universal proof-tree rotation.
Reassociation succeeds only when the family validates the proposed intermediate
composition; equality is required when both bracketings exist.

Dynamic proof-refined extraction lineage names exactly its selected and
remainder parts. Bounds failure is not an ownership path: if the relationship
premise is unproved, the extraction is rejected before lineage is minted.

## 8. Certificate discipline

A certificate has the abstract shape:

```text
Certificate = (
  rule,
  conclusion,
  premise identities,
  source origin,
  revision,
  schema
)
```

The consumer reconstructs every premise. A certificate checker reduces trust
only when it is smaller than the producer and refuses unknown rules, malformed
paths, duplicate lineage, invalid partitions, foreign identities, and stale
revisions.

Evidence erases from run-time values after authorizing lowering. Compact
Runtime- HIR references may remain only to let validation connect a destructive
or proof-required occurrence to its replayed result.

Failure to construct evidence from source is a `SourceDiagnostic` at the
operation requiring it. Producer success followed by validator failure is an
`InvariantFailure`. Exhausting a documented solver or compiler budget is a
`LimitDiagnostic`, not an approximate proof.

## 9. Theorem obligations

Accepted safety evidence establishes:

- a closed match does not reach a missing arm;
- every proof-required operation satisfies its exact proposition;
- no path is moved twice or moved through a borrow;
- no borrow escapes its admitted boundary;
- affine paths are consumed at most once and may be discarded;
- linear paths are consumed exactly once on every terminating exit;
- aggregate, closure, callback, and partition ownership is conserved by mode;
- a consuming action erased by demand contributes no ownership transition; and
- every permitted target mutation is observationally related to the persistent
  source operation it implements.

Finite-domain coverage generation, proposition mutation tests, path-generated
ownership tests, certificate replay, source/Rust/Wasm differential execution,
and Store-write classification are evidence for these obligations. None becomes
a second safety semantics.
