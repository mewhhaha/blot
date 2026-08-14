# Partitioned ownership regions

Status: experimental design. This file is deliberately ahead of `LANGUAGE.md`.
The executable probes live in `experiments/owned-regions/`. Nothing here is a
supported source-language rule until the checker, Runtime HIR, evaluator, Wasm,
and preservation gates agree.

The motivating program is quicksort over one Store. Partitioning should
rearrange one backing allocation, split permission to mutate it into disjoint
child regions, recurse over the children, and rejoin the permission without
copying the array at each recursive step.

The useful compiler concept is broader than arrays:

> A **partitioned ownership authority** is a linear capability naming one region
> of one private runtime resource. A trusted partition consumes one authority
> and produces authorities for a disjoint cover. A trusted combine consumes
> compatible authorities and produces their union.

The design keeps regions out of algebraic subtyping. Ordinary value types still
describe values. Blot's existing flow-sensitive ownership analysis decides when
a capability is consumed; a separate region derivation proves what part of a
resource that capability authorizes.

## 1. The proof stack

Implementation feedback exposed three facts which must not be conflated:

```text
Store provenance
    -> path-sensitive linear ownership
        -> region-family derivation
            -> destructive Runtime-HIR operation
```

Each layer answers a different question.

### 1.1 Store provenance: may this allocation be stolen?

Consider:

```blot
let shared = [1, 2, 3]
let !candidate = shared
```

The `!` marker constrains how `candidate` is consumed. It does not by itself
prove that `shared` cannot still denote the same persistent Store. A destructive
write through `candidate` could therefore be observed through `shared`.

A **Store root** is stronger evidence: it proves that an allocation has no
source-visible persistent observer while destructive authority is active.

The simplest root is a fresh private allocation. An optimization may preserve a
root through an operation whose existing reuse proof shows that the old Store is
consumed and no observer survives.

Region checking never invents Store roots.

### 1.2 Existing ownership: is this authority used on every path correctly?

Region authority is a linear obligation carried by an ordinary source value. Its
branch, loop, closure, and recursive-call behavior belongs to the existing
ownership checker.

This matters because a static compiler certificate is not a runtime event log.
For example:

```text
if condition:
  transform p at site A
else:
  transform p at site B
```

Both sites consume `p` in source, but they are alternatives. A flat sequence
`A; B` would falsely look like a double consumption. The current ownership
certificate already represents this correctly: one binding can have multiple
consumption sites while the checker proves that each execution path consumes it
exactly once.

Therefore region support must extend the existing `Produced`/lineage machinery
rather than replace it with a second path-analysis algorithm.

### 1.3 Region derivation: what memory may this authority touch?

Once path-sensitive ownership has established that capabilities are neither
duplicated nor leaked, a family-specific derivation proves how their write sets
relate.

For an array interval:

```text
Own(root, [lo, hi))
```

A partition witnesses:

```text
[lo, hi) = [lo, mid) * [mid, hi)
```

where `*` is defined only for disjoint regions whose ordered union is valid.
This is a small separation algebra: split factors one permission; join composes
compatible permissions; a transform preserves the permission while changing the
resource contents.

A new proof-producing collection can reuse the ownership integration after it
supplies its own checked region algebra.

## 2. Array interval algebra

For a Store `S` of extent `n`, an interval is:

```text
R = [lo, hi)
0 <= lo <= hi <= n
```

Two non-empty intervals for one origin are disjoint iff:

```text
hi1 <= lo2 || hi2 <= lo1
```

Empty intervals authorize no address and are disjoint from every interval.

The invariant is:

> All simultaneously live write authorities for one Store root are pairwise
> disjoint.

Ordered composition is:

```text
[lo, mid) * [mid, hi) = [lo, hi)
```

A split at relative offset `k`, with `0 <= k <= hi - lo`, produces:

```text
[lo, lo+k)   [lo+k, hi)
```

The outputs are a disjoint exact cover of the input. The pure validator in
`src/linear/region_interval.ts` implements these laws independently of any
compiler control-flow representation.

## 3. `claim` has copy-safe source semantics

A useful source operation should not require a new uniqueness type merely to be
safe:

```text
claim : [A] -> Slice A
```

For the first implementation, `A` is restricted to values whose array contents
carry no linear or affine obligations. Its semantic meaning is:

1. create a private Store initialized from the input array;
2. create a fresh Store root for that allocation;
3. create the full interval authority `[0,len)`; and
4. return a linear slice carrying that authority.

This is safe even when the source array is shared because old aliases observe a
different Store.

The compiler may elide the acquisition copy only when Store provenance proves
that the input allocation is already uniquely reusable:

```text
unknown/shared input
  array --copy--> fresh private Store --claim--> Slice

proved unique input
  array ---------reuse root-----------> Slice
```

Allocation identity is not source-observable, so these implementations have the
same source meaning.

This separates acceptance from optimization:

- ordinary code can always claim a slice of copyable elements; and
- zero-copy acquisition requires a verified Store root.

Arrays containing owned elements need a consuming acquisition which _moves_
those obligations rather than copying them. That extension should be built on
existing consuming-array lineage and is deliberately outside the first patch.

## 4. Trusted intrinsic boundary

Names are provisional. Application code should eventually call prelude wrappers;
`@region.*` is the small trusted boundary recognized by ownership and Runtime
HIR.

### `@region.claim`

Creates a full array-interval authority. The evaluator may always take the
copy-safe path. Runtime HIR may use a proof-backed reuse path.

```text
Slice(S, 0, len(S)) carries Own(root, [0,len(S)))
```

A reuse lowering must cite a valid Store root. A fresh lowering creates one.

### `@region.split`

Consumes one authority and, on success, produces two child authorities plus the
recombination witness that rejoins them:

```text
Own(root,[lo,hi))   0 <= k <= hi-lo
------------------------------------
Own(root,[lo,lo+k)) * Own(root,[lo+k,hi)) * Rejoin(root,lo,lo+k,hi)
```

The runtime operation changes metadata only, and the witness is element-free: it
erases to unit at Runtime-HIR lowering. Failure returns the original authority
and mints nothing:

```text
#Split (left, right, rejoin)
| #SplitOutOfBounds original
```

No element Store is copied.

### `@region.join`

Consumes a recombination witness and the two part authorities it was minted
with:

```text
Rejoin(root,lo,mid,hi) * Own(root,[lo,mid)) * Own(root,[mid,hi))
----------------------------------------------------------------
Own(root,[lo,hi))
```

The witness is the proof: ownership pairs it with its two parts by
produced-value identity, so the proof travels through bindings and function
calls like any linear value (section 13). Reassociating nested partitions by
bare adjacency is deliberately given up in this version; a checked
witness-combination law can restore it later if a program needs it.

### `@region.length`

Borrows a slice and returns its interval length. It changes no authority.

### `@region.get`

Borrows a slice and reads relative to its start:

```text
&Own(root,[lo,hi))   0 <= i < hi-lo
------------------------------------
S[lo+i]
```

The eventual checked form should use the same proof-producing bounds machinery
as direct `@array.get`.

The first implementation is for unrestricted element ownership. Region authority
does not make an owned element copyable.

### `@region.set`

Consumes one authority and returns its successor over the same interval:

```text
Own(root,R)   i in R
--------------------
Own(root,R)
```

The Store-root proof excludes persistent observers; the interval proof excludes
other live write authorities for the address.

The first implementation should reject replacing an element whose old or new
value carries an ownership obligation. A later consuming replacement can state
the transfer explicitly.

### `@region.swap`

Consumes one authority, swaps two in-range positions, and returns the successor
authority for the same interval.

This is the important sorting primitive. It moves slots internally instead of
copying them and leaves a clean path to supporting owned elements later.

### `@region.freeze`

Consumes the sole live full-region authority and returns an ordinary persistent
array:

```text
Own(root,[0,len(S)))
---------------------
[A]
```

No destructive authority survives. The first implementation requires this to be
the only live permission for the root, including empty permissions.

`freeze` intentionally ends the private destructive phase. A later claim remains
semantically valid by copying and may steal again only if separate Store
provenance re-establishes uniqueness.

## 5. Source-facing `Slice`

A prelude wrapper can keep application code ordinary:

```blot
const Slice = {
  .claim = fn values => @region.claim values;
  .length = fn &slice => @region.length (&slice);
  .split = fn (!slice, index) => @region.split (slice, index);
  .join = fn (!rejoin, !left, !right) => @region.join (rejoin, left, right);
  .get = fn (&slice, index) => @region.get ((&slice), index);
  .set = fn (!slice, index, value) =>
    @region.set (slice, index, value)
  ;
  .swap = fn (!slice, left, right) =>
    @region.swap (slice, left, right)
  ;
  .freeze = fn !slice => @region.freeze slice;
}
```

The backing Store must not be projectable from source. A Runtime-HIR
representation may contain `(store,start,length,extent)`, but that layout is
compiler-private and refused by ABI 1.

These wrappers certify as ordinary source: a region proof over an abstract
parameter defers to the call site, where substitution makes the caller's
authority concrete (section 13). No compiler trust attaches to the prelude. The
checkers still recognize unshadowed `Slice.*` calls by name — that is the
remaining bridge over ownership summaries not yet crossing module interfaces,
and section 13 records it as the last scaffolding to delete.

## 6. Static certificate shape

The production proof should reuse the current ownership certificate rather than
record a flat authority program.

Conceptually, each region-carrying ownership leaf gains region lineage:

```text
claim(root, family, operation)
partition(parent, part, part_count, operation)
combine(parents, operation)
transform(parent, operation)
```

The existing ownership pass remains responsible for whether that leaf is used
exactly once on each path. Region verification checks only local derivation
facts:

- a `claim` is backed by either fresh allocation or a verified reuse root;
- all parts of a partition are accounted for, as existing consuming extraction
  lineage already requires for `@array.take` and `@array.split`;
- a partition's family validator proves its outputs are a disjoint exact cover;
- a combine consumes compatible authorities and its validator proves their
  composition;
- a transform preserves root and region; and
- Runtime HIR binds every destructive operation to the exact certified source
  occurrence.

This makes branch handling compositional. Each branch carries the same incoming
ownership state; the existing branch agreement checks the outgoing obligation.
Region lineage follows the value on that branch and does not need to flatten the
branches into one fake execution order.

## 7. What `region_certificate.ts` currently proves

`src/linear/region_certificate.ts` is an executable **single-path trace
oracle**, not yet the production static source certificate.

It checks the linear graph for one concrete trace:

```text
claim(root, origin, family) -> p
partition(p)                -> [p1, ..., pn]
combine([p1, ..., pn])      -> p
transform(p)                -> p'
release(p)
```

It rejects untrusted roots, duplicate root/origin/permit production,
use-after-partition, incompatible combine inputs, double release, and leaked
leaves.

The runtime model records its actually executed trace and replays it at freeze.
That is useful executable evidence for the algebra, but it must **not** be wired
as the source compiler's only ownership certificate: mutually exclusive source
branches are not one runtime trace.

The production integration is the lineage design in section 6, checked alongside
the existing path-sensitive ownership certificate.

## 8. Failure conservation

Every total operation must return all authority it received on failure.
Otherwise an error path could silently leak a linear resource.

Bad:

```text
split : Own R -> Result (Own L * Own R) Error
```

Required:

```text
split : Own R -> Split (Own L) (Own R) | OutOfBounds (Own R)
```

Likewise:

- failed join returns both inputs;
- failed set returns its input; and
- failed swap returns its input.

A failed operation creates no region derivation because no ownership transition
occurred.

## 9. Preservation argument

Assume a valid Store root for allocation `S`: no persistent source-visible alias
may observe destructive changes to `S` while that root is active.

Let `Live(S)` be the intervals authorized by the live linear ownership leaves
for that root. Maintain:

```text
forall R1 != R2 in Live(S). disjoint(R1,R2)
```

### Claim

Fresh claim creates a private Store, so the root premise holds by construction.
Reuse claim is admitted only with Store-provenance evidence. `Live(S)` begins as
one full interval.

### Split

Replacing `[lo,hi)` with `[lo,mid)` and `[mid,hi)` preserves pairwise
disjointness because both children are subsets of the parent and are disjoint
from each other. The existing ownership checker prevents either child from being
duplicated later.

### Join

Replacing adjacent `[lo,mid)` and `[mid,hi)` with `[lo,hi)` preserves the
invariant: any third live interval overlapping the union would have overlapped
at least one input. The ownership checker proves both inputs are consumed by the
join path.

### Set/swap

The operation touches only addresses inside one live interval. Every other live
write authority is disjoint, and the Store root excludes persistent observers.
The ownership checker proves that the old authority is consumed while a
same-region successor is produced.

### Branches

Each branch starts from the same ownership state. Existing ownership agreement
requires every outgoing path to discharge or transfer the same linear
obligations. Region derivations on mutually exclusive paths therefore do not
coexist in `Live(S)`.

### Freeze

Freeze consumes the sole full authority before exposing the ordinary persistent
array. No destructive permission remains able to change the Store after it
becomes shareable again.

Hence a destructive operation authorized by all three proof layers is
observationally equivalent to persistent source semantics: allocation identity
may change; source-visible values do not.

## 10. Quicksort

The executable experiment uses Lomuto partitioning with `swap`. Its intended
Blot shape is:

```blot
let quicksort =
  rec (fn !slice =>
    if Slice.length (&slice) <= 1:
      return slice

    let (slice, pivot) = partition slice

    if let #Split (left, rest) = Slice.split (slice, pivot) else:
      @panic "proved split failed"

    if let #Split (middle, right) = Slice.split (rest, 1) else:
      @panic "proved pivot split failed"

    let left = quicksort left
    let right = quicksort right

    let slice = Slice.join (left, middle)
    return Slice.join (slice, right)
  )
```

The element Store is never copied during partition, split, recursive sorting, or
join. The only possible O(n) copy is acquisition of a private Store, and Store
provenance can eliminate that copy.

```text
shared/unknown input: one O(n) acquisition copy + in-place quicksort
proved unique input: zero acquisition copy + in-place quicksort
```

The recursive calls own disjoint regions. A sequential backend calls them in
order; a future parallel backend could use the same separation proof without
changing source semantics.

## 11. Why this is not general mutable references

The proposal does not introduce arbitrary addresses which can be stored,
returned, compared, or freely aliased. A slice is a private resource view with a
compiler-known region family and linear ownership transitions.

That restriction keeps the proof local:

- no lifetime parameters;
- no alias search through arbitrary heap graphs;
- no mutable-reference subtype relation;
- no region variables inside algebraic type inference; and
- no second control-flow ownership checker.

A new region family can reuse the pattern only after it supplies checked
partition/combine/transform laws.

### 11.1 Why regular-path borrow tracking is deferred

Nowacki et al.'s
[regex-based Move borrow checker](https://verse-lab.org/papers/regex-borrows-oopsla26.pdf)
gives a useful design for a different boundary. It assigns each live reference
an abstract identity and labels reachability edges with regular languages of
field paths. Brzozowski derivatives expose the paths reachable after a field
borrow, union joins alternative control-flow paths, Kleene star summarizes
unknown borrow chains across calls, and write safety reduces to regular-language
emptiness. The path environment remains an auxiliary judgment rather than
ordinary value-type structure.

That machinery is justified when references are first-class, may escape a call,
and coexist with mutation. Blot's borrow is none of those things: it is a
transient read-only view, and the region proposal exposes linear capabilities
rather than addresses. Adding a regular-path environment now would duplicate the
existing ownership control-flow analysis without discharging either Store
provenance or the family-specific region derivation.

It is also too coarse for the motivating array program. The Move model gives
every vector element the same path symbol, deliberately refusing to distinguish
simultaneous borrows of different indices. Blot's quicksort proof instead needs
the exact interval separation algebra in section 2. A regex can describe a set
of structural access paths; it does not prove that two numeric intervals are a
disjoint exact cover. Recombination witnesses likewise preserve the exact
sibling relation that a conservative call summary would forget.

If Blot later admits stored or returned borrows, regular-path reachability is a
candidate provenance calculus. A bounded experiment should then use fresh
abstract references, derivative-based extension, union at branch joins, removal
of consumed references, and checked call/return summaries. It must remain
separate from algebraic subtyping and compose with, rather than replace, Store
roots and region-family laws. No such experiment is warranted until a concrete
program requires a borrow to escape the current lexical boundary.

## 12. Production gates

Before moving any of this into `LANGUAGE.md`, require:

- Store-provenance tests proving zero-copy claim is denied when an older
  persistent alias could observe the Store;
- a copy fallback proving ordinary claim remains valid for shared inputs;
- a first-version restriction or consuming transfer proof for owned elements;
- path-sensitive tests where alternative branches consume/transform one slice;
- lineage tamper tests proving every partition output is accounted for;
- family tests for exact split cover, adjacency, bounds, empty intervals, and
  full freeze;
- failure-conservation tests on every total operation;
- evaluator/Runtime-HIR/Wasm agreement;
- ABI refusal for live slice values;
- an in-place quicksort corpus entry whose recursive split/join path allocates
  no element Stores after acquisition; and
- a benchmark separating acquisition-copy cost from partition/sort cost.

Until those gates pass, `@region.*` remains an experimental trusted boundary,
not part of Blot's implemented language. Section 13 is part of those gates: the
name-keyed wrapper recognition and the prelude ownership exemption are
scaffolding of the current draft, and stabilization replaces them rather than
canonizing them.

## 13. Recombination witnesses

Implemented. The first draft carried three compensations that contradicted the
prelude's own principle that nothing in it is built into the compiler:

- the ownership checkers certified the prelude's `Slice` wrappers under a
  trusted mode, because a join of two abstract parameters had no split lineage
  to inspect;
- both checkers recognize an unshadowed variable spelled `Slice` and map its
  fields back to `@region.*`, so caller-side proofs bypass the wrapper; and
- argument interpretation changes when the callee is spelled `Slice`, to unpack
  the wrappers' tuple calling convention.

Each was the same missing abstraction. The ownership summary of a function
cannot express a relation between two of its arguments — "these are the sibling
halves of one split" — so the relation was patched in by name. A relational
contract language would express it, but there is a smaller design, now
implemented: make the relation a value. The trusted mode is deleted; a region
proof over an abstract parameter defers as a pending obligation carried in the
function's summary and is discharged at the call site, after parameter
substitution makes the caller's authorities concrete. The name recognition and
tuple unpacking remain only as the bridge over ownership summaries not yet
crossing module interfaces; serializing function ownership summaries into module
interfaces deletes them too.

### The witness

`@region.split` returns three linear values on success. `@region.join` consumes
three:

```text
split : !Own(root,[lo,hi))  k
        -> #Split (Own(root,[lo,lo+k)),
                   Own(root,[lo+k,hi)),
                   Rejoin(root, lo, lo+k, hi))
         | #SplitOutOfBounds Own(root,[lo,hi))

join  : !Rejoin(root, lo, mid, hi) * !Own(root,[lo,mid)) * !Own(root,[mid,hi))
        -> Own(root,[lo,hi))
```

`Rejoin` is an unforgeable, opaque, element-free capability: the proof that its
two parts recombine into their parent, reified as a value. It carries no data a
program can read, costs metadata only, and is erased entirely at Runtime-HIR
lowering — the runtime join operation is unchanged, taking the left part's start
and the right part's end.

### Why this fits the proof stack

The pairing between a witness and its two parts lives in the ownership
analysis's produced values, keyed by value identity, not in the type lattice.
The witness's type is one opaque nominal; no region variable enters algebraic
inference, so every restriction in section 11 still holds. Join checks that its
first argument's produced value is the witness whose recorded parts are exactly
the other two arguments. Where the analysis cannot trace a witness, it rejects —
the same conservatism as the current lineage proof.

What changes is composition. The current proof dies at a function boundary:
lineage is visible only at the split's own call site, which is why the checker
must recognize wrappers by spelling. A witness travels through bindings, tuples,
case arms, and calls by the ordinary parameter-substitution machinery that
already threads concrete authorities into function results. A user function that
receives a witness and two parts and joins them certifies with no new rules:

```blot
let rejoin_sorted = fn (!rejoin, !left, !right) =>
  Region.join ((!rejoin), (quicksort (!left)), (quicksort (!right)))
```

No compiler rule remembers that two arguments originated from one particular
split; the proof arrived with them.

### Obligations

- A witness is linear. Leaking one is the ordinary unconsumed-linear error, and
  correctly so: losing the ability to rejoin means the root can never be
  reassembled for `freeze`.
- A witness is refused at ABI 1 exactly as a live region authority is.
- Witness pairing proves sibling recombination of one split. The section 4
  adjacency rule — reassociating nested partitions — is deliberately given up in
  the first version; a checked witness-combination law can restore it later if a
  program needs it.
- Failure conservation extends to the witness: `#SplitOutOfBounds` returns the
  parent authority and mints nothing.

### Quicksort under witnesses

```text
whole
  |
split -> left, rest, J1
                 |
            split -> pivot, right, J2

sort left, sort right
join J2 pivot right
join J1 left (pivot ++ right)
```

Every recombination names its proof. The recursion passes witnesses down as
ordinary linear values, so helper functions of any shape stay certifiable.

### What this deletes

With witnesses, the prelude's `Slice` wrappers are ordinary certifiable source:
each body forwards values whose proofs travel with them.

Deleted in this revision, from both checkers:

- the trusted-prelude ownership mode and every path by which the prelude was
  identified.

Remaining scaffolding, deletable once function ownership summaries are
serialized into module interfaces:

- the name-keyed recognition of `Slice.*`; and
- the `Slice`-specific tuple-argument reinterpretation.

Within one module the replaceability test already holds: a user wrapper over
split, join, or freeze — any name, any shape — certifies with no new rules,
because the deferred proof discharges where the caller's concrete authorities
substitute in. Across modules, `Slice` is still the one spelling the checkers
bridge by name.

### Family generality

The witness generalizes the family contract of section 11: a region family's
partition operation returns pieces plus a recombination witness, and its combine
operation consumes them. Matrix tiles, tree partitions, and arena chunks can
implement the same shape without either checker learning anything per family
beyond the family's own partition/combine laws.
