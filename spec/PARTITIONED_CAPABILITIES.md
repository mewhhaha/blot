# Partitioned capability algebra

## Status and scope

[`LANGUAGE.md`](../LANGUAGE.md), subject to
[`COHERENCE.md`](COHERENCE.md), remains the source-language authority. This
document owns the reusable ownership proof beneath concrete collection adapters
such as `Slice`.

A partitioned capability is exclusive authority over a footprint of one
resource. It may be factored into authorities for an exact disjoint cover,
transformed locally, and recombined only with the exact proof produced by that
factorization.

The generic layer proves conservation and exclusivity. A family adapter decides
what a footprint, address, and local transform mean for arrays, maps, tiles,
trees, arenas, or another resource.

## 1. Boundary

The design preserves these constraints:

- ownership remains a flow judgment outside ordinary subtyping;
- source wrappers are ordinary code rather than privileged names;
- proof-only values erase before Runtime HIR and ABI closure;
- only registered compiler families may mint separation evidence;
- Rust producers and target validators check the same family-tagged certificate;
  and
- a source abstraction invariant is separate from the generic authority proof.

The family registry is a compiler trust boundary. Arbitrary source code cannot
claim two footprints are disjoint, assert exact cover, manufacture a root, or
forge a partition witness.

## 2. Family model

A capability family `F` supplies:

```text
Root_F       resource identities
Foot_F       footprint descriptions
Place_F      owned member positions
Address_F    operation addresses
empty_F      empty footprint
whole_F      complete root footprint
(*)_F        partial ordered composition
places_F(p)  positions authorized by p
focus_F(p,a) selected position, when defined
```

An authority is written:

```text
Cap(F, root, p, E)
```

where `p : Foot_F` and `E` is the hidden ownership payload indexed by positions
of `p`. `E` is analysis state, not a source-visible type member or run-time
capability object.

The composition operator is deliberately ordered and partial. The generic core
does not assume commutativity. Array segments, list segments, tree children, and
ordered map ranges have observable order. A family such as finite key sets may
prove a stronger commutative law for its own operations.

## 3. Family laws

### 3.1 Family and root agreement

Composition never crosses families or roots:

```text
Cap(F,r,p,_) * Cap(G,s,q,_)
```

is defined only when `F = G` and `r = s`.

Equal-looking footprints under different resources or family adapters are not
interchangeable.

### 3.2 Separation

If `p * q` is defined, the authorized write sets are disjoint:

```text
places_F(p) intersect places_F(q) = empty
```

This permits both child authorities to remain live simultaneously.

### 3.3 Exact cover

Composition neither drops nor invents positions:

```text
places_F(p * q) = places_F(p) union places_F(q)
```

The hidden ownership payload is partitioned by the same cover.

### 3.4 Unit

The empty footprint authorizes no write:

```text
places_F(empty_F) = empty
```

Whenever the corresponding compositions are admitted:

```text
empty_F * p = p
p * empty_F = p
```

A family may avoid constructing empty run-time views while validating the unit
law at the proof level.

### 3.5 Conditional associativity

Because composition is partial, the generic law is result coherence when both
bracketings exist:

```text
(p * q) * r defined    p * (q * r) defined
------------------------------------------------
(p * q) * r = p * (q * r)
```

Definedness of one bracketing does not imply definedness of the other.
Rectangular tiles are the canonical counterexample: two adjacent top tiles may
compose into a full-width strip that composes with a bottom strip, while one top
tile composed with the bottom strip would form a forbidden L shape.

A particular family may prove the stronger partial-monoid property that either
bracketing implies the other. The generic checker does not assume it.

### 3.6 Deterministic focus

An address resolves to at most one authorized position:

```text
focus_F(p,a) = x    focus_F(p,a) = y
-------------------------------------
x = y
```

When `p * q` is defined, a successful focus belongs to exactly one non-empty
child. One address cannot spend two member obligations.

### 3.7 Frame locality

A transform through `p` cannot change observations reachable only through a
disjoint frame `q`:

```text
p * q defined
transform(state,p,a,v) = state'
--------------------------------
observe(state,q) = observe(state',q)
```

Frame locality connects footprint separation to destructive Runtime-HIR
operations.

### 3.8 Ownership conservation

Let `Omega(x)` be the multiset of affine and linear obligations inside analysis
value `x`. Every outcome of a capability operation satisfies:

```text
Omega(consumed inputs) = Omega(returned values in that outcome)
```

The equation is path-sensitive. Alternative success and failure outcomes are
checked independently; their obligations are not added together.

## 4. Proof objects

Factoring an authority produces two child capabilities and a linear witness:

```text
Cap(F,r,p,E)    p = l * rgt    E = E_l * E_r
------------------------------------------------ partition
Cap(F,r,l,E_l), Cap(F,r,rgt,E_r), Part(F,r,p,l,rgt,k)
```

`k` is the factorization-event identity. `Part` records family, root, parent,
ordered children, and event lineage. It contains no resource element.

Combination consumes the exact witness and exact children:

```text
Part(F,r,p,l,rgt,k)
Cap(F,r,l,E_l)
Cap(F,r,rgt,E_r)
------------------------------------------------ combine
Cap(F,r,p,E_l * E_r)
```

Matching only family, root, or equal footprint is insufficient. A stale witness,
a witness from another split event, or equal extents under another produced-value
lineage cannot authorize combination.

No source operation fabricates `Part`. It is minted only after the registered
family validates factorization, or by an admissible coherence rewrite over
already valid witnesses.

## 5. Proof-tree coherence

Given:

```text
J1 : Part(F,r,abc,a,bc,k1)
J2 : Part(F,r,bc,b,c,k2)
```

left reassociation proposes:

```text
ab = a * b
J4 : Part(F,r,abc,ab,c,k4)
J3 : Part(F,r,ab,a,b,k3)
```

The operation succeeds only when the family adapter validates `a * b` and the
resulting parent equations. It consumes `J1` and `J2` and returns `J3` and `J4`.
Right reassociation has the symmetric condition.

If the target intermediate composition is undefined, reassociation is refused
and the original proof tree remains the only admissible bracketing. This is not
an ownership failure: the existing capabilities are still valid; only that proof
rotation is unavailable.

Coherence is proof-only:

```text
runtime(reassociate(...)) = unit
```

Its compiler cost may be constant for a family with canonical footprints, but a
family registration must state and test its actual proof-normalization cost.
The checker cannot normalize by silently resurrecting consumed witnesses.

## 6. Generic operations

### 6.1 Acquisition and release

```text
acquire_F(Resource(E)) = Cap(F,r,whole_F,E)
release_F(Cap(F,r,whole_F,E)) = Resource(E)
```

Acquisition may copy run-time storage only when copying the payload is permitted.
If `E` contains owned values, acquisition consumes and transfers the source
payload or is rejected.

Release requires the complete root footprint. Releasing an arbitrary part would
drop complement authority or expose aliased mutable storage.

### 6.2 Borrowed observation

```text
observe_F(&Cap(F,r,p,E), a) -> &E[position]
```

A source operation may return an ordinary copied member only when the selected
member is unrestricted. A true borrow remains lexical and cannot escape.

### 6.3 Consuming exchange

Exchange is the ownership-general member update:

```text
exchange_F(!Cap(F,r,p,E), a, !N)
  -> #Exchanged(!E[position], !Cap(F,r,p,E[position := N]))
   | #NotFound(!N, !Cap(F,r,p,E))
```

Both outcomes return every incoming obligation exactly once. Failure performs no
run-time mutation. A discarding write is a special case permitted only when the
displaced member is unrestricted or another explicit consumer accounts for it.

### 6.4 Permutation and shape transform

A permutation preserves the ownership multiset:

```text
Omega(permute_F(Cap(F,r,p,E), pi)) = Omega(E)
```

A shape transform changes footprint representation only with a checked
isomorphism between old and new positions, preservation of root identity, and
frame locality.

## 7. Generic core versus family adapter

| Concern | Generic capability core | Family adapter |
| --- | --- | --- |
| exclusive use through branches and calls | yes | no |
| family and root identity | checks | supplies |
| exact witness lifecycle | yes | validates factorization |
| ownership conservation | yes | maps positions to payloads |
| proof-tree reassociation | consumes exact witnesses | validates target partial composition |
| address meaning | no | supplies index, key, path, or handle semantics |
| bounds or membership proof | no | supplies |
| run-time representation | no | supplies Store, nodes, buckets, pages, or links |
| destructive lowering | authorizes one occurrence | emits family operation |
| acquisition/release cost | checks transfer safety | chooses copy, reuse, or materialization |

The division avoids both hardcoding every collection into ownership flow and
allowing source code to assert unverified separation.

## 8. Family examples

### 8.1 Array intervals

```text
Foot = [lo,hi)
[a,b) * [b,c) = [a,c)
Address = relative integer index
```

This is the production family used by `Slice` and by the positional authority
under the ordered-text-map adapter. It admits the stronger associative
definedness property for adjacent ordered intervals.

### 8.2 Finite key sets

```text
Foot = finite key set
P * Q defined when P intersect Q = empty
Address = key
```

This family is usually commutative. A production registration still requires a
stable key identity and a run-time adapter; a proof-law model alone does not
create a supported map representation.

### 8.3 Rectangular tensor tiles

```text
Foot = ([x0,x1), [y0,y1))
Address = (x,y)
```

Tiles compose only along one complete matching face. An L-shaped union is not a
rectangle. Therefore not every proof-tree rotation is admissible. The law model
must test equality where both bracketings exist and refusal where a proposed
intermediate is L-shaped.

A destructive tensor family additionally needs a Store/stride representation
and end-to-end target registration.

### 8.4 Linked sequences

A list segment may be identified by root plus ordered endpoint identities. Its
combine proof is a splice boundary or zipper context rather than arithmetic
adjacency. Zero-copy partition requires exclusive links; a persistent list may
implement the same source operation by copying a spine.

### 8.5 Trees

A subtree alone is not enough to rebuild the whole tree. Partition returns the
selected subtree, disjoint siblings or remainder, and a zipper-shaped witness.
Rebalancing changes paths and must transform every live witness through a checked
footprint isomorphism.

### 8.6 Ordered maps

The current `OrderedTextMap` is not a separate compiler family. It refines an
array interval with a constructor-established strict-ordering protocol. The
compiler proves interval authority; the source adapter preserves ordering. A
true non-contiguous key-set family is a separate future registration.

### 8.7 Arenas and allocators

An arena may partition page ranges or sets of `(slot,generation)` handles.
Generation is part of position identity; otherwise a freed and reallocated slot
could satisfy a stale capability.

### 8.8 Graphs

Disjoint node sets do not automatically imply disjoint mutation because edges
may cross the cut. A graph family must own incident edges, return an explicit cut
set, separate node and edge authority, or combine read sharing with exclusive
local mutation. Node-set disjointness alone does not prove frame locality.

## 9. Compiler representation

The ownership checker uses family-tagged analysis values:

```text
Capability {
  family,
  root,
  footprint,
  payload-lineage
}

PartitionWitness {
  family,
  root,
  parent,
  left,
  right,
  factorization-event
}
```

Family identity and semantic revision are serialized in closure ownership
contracts and certificates. A cached contract from a compiler that assigns a
different meaning to a family is invalid.

Proof-only values erase before Runtime HIR. Runtime HIR receives only the
validated permission attached to one destructive occurrence and the family's
closed run-time representation.

## 10. Non-goals

This algebra does not introduce:

- ownership qualifiers into ordinary subtyping;
- source lifetime or region parameters;
- user-defined unsafe family registration;
- a promise that every data structure admits zero-copy partition;
- fractional shared-write permissions;
- implicit witness search by equal-looking footprints;
- universal proof-tree reassociation; or
- a public run-time capability object in ABI 1.

Read sharing remains immutable persistence or lexical borrowing. Concurrent
shared mutation requires another algebra and synchronization semantics.

## 11. Registration requirements

A production family is accepted only after independent producer and validator
evidence for:

1. family and root separation;
2. disjointness and exact cover for every factorization constructor;
3. unit laws on admitted footprints;
4. equality whenever both associative bracketings are admitted;
5. refusal of reassociation when the target intermediate is undefined;
6. deterministic focus and frame locality;
7. path-sensitive ownership conservation on success and failure;
8. exact witness consumption and rejection of stale, foreign, or copied proof;
9. acquisition/release behavior for unrestricted and owned members;
10. proof erasure and ABI refusal for live capabilities or witnesses;
11. source, Runtime-HIR, Rust evaluator, and emitted-Wasm observation agreement;
    and
12. an explicit cost model separating semantic guarantees from optimized reuse.

Law tests use generated or exhaustively bounded footprint domains. Passing a few
examples is not registration evidence, and a law adapter does not by itself
create a run-time representation.
