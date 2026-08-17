# Partitioned capability algebra

Status: compiler design and implementation contract. `LANGUAGE.md` remains the
normative source-language specification. This document defines the reusable
ownership proof beneath concrete collection APIs such as `Slice`.

## 1. Purpose and boundary

`Slice` is not the general concept. It is the first runtime adapter for a more
general one:

> A partitioned capability is an exclusive authority over a footprint of one
> resource. It may be factored into authorities for an exact disjoint cover,
> transformed locally, and recombined only with the proof produced by that
> factorization.

The generic layer answers whether authority and owned members are conserved. It
does not know how an integer indexes an array, how a key selects a map entry,
how a path reaches a tree node, or how any of those structures are represented
at runtime. Those decisions belong to a family adapter.

This separation preserves Blot's existing constraints:

- ownership remains a flow analysis outside the type lattice;
- ordinary wrappers remain source code rather than privileged names;
- only operations that cannot be expressed in Blot earn primitives;
- proof-only values disappear before Runtime HIR and the public ABI; and
- Node and Rust independently validate the same certificate.

The first implementation registers only the array-interval family. A family
registry is a compiler trust boundary, not a source extension point. Arbitrary
source code cannot claim that two footprints are disjoint or manufacture a
partition witness.

## 2. Family model

A capability family `F` supplies:

```text
Root_F       resource identities
Foot_F       footprint descriptions
Place_F      addressable member positions
empty_F      the empty footprint
(*)_F        partial ordered composition of footprints
places_F(p)  the positions authorized by p
focus_F(p,a) the position selected by address a, when it exists
```

An authority is written:

```text
Cap(F, root, p, E)
```

where `p : Foot_F` and `E` is the hidden ownership payload indexed by the
positions of `p`. `E` is analysis state, not a source-visible field or type.

The composition operator is deliberately **not assumed commutative**. Array and
list segments have an observable order; tree children may have named or ordered
positions. A particular family may prove commutativity, as a key-set partition
usually can, but the generic checker never swaps operands silently.

For a single root, `p * q` is defined only when the family proves the two
footprints compatible. A valid family satisfies these laws.

### 2.1 Root agreement

Composition never crosses resources:

```text
Cap(F, r, p, _) * Cap(F, s, q, _) is defined only if r = s
```

Family identity is part of the proof. Equal-looking footprints from different
families are never interchangeable.

### 2.2 Separation

If `p * q` is defined, the authorized write sets are disjoint:

```text
places_F(p) intersect places_F(q) = empty
```

This is the safety property that permits simultaneous live child authorities.

### 2.3 Exact cover

Composition neither drops nor invents positions:

```text
places_F(p * q) = places_F(p) union places_F(q)
```

The hidden ownership payload is partitioned by the same cover.

### 2.4 Unit

The empty footprint authorizes no write and is a two-sided unit whenever the
family's representation admits it:

```text
empty_F * p = p = p * empty_F
places_F(empty_F) = empty
```

Families may avoid constructing empty runtime views while still validating the
law for proof purposes.

### 2.5 Associativity and coherence

Whenever either side is defined, both bracketings describe the same footprint:

```text
(p * q) * r = p * (q * r)
```

The proof objects are not definitionally equal: they are different trees.
Witness reassociation is the explicit coherence operation relating the trees. It
consumes the old witnesses and creates the rotated witnesses without touching
runtime state.

### 2.6 Deterministic focus

An address resolves to at most one authorized position:

```text
focus_F(p, a) = x and focus_F(p, a) = y implies x = y
```

If `p * q` is defined, a successful focus belongs to exactly one non-empty side.
This prevents a structure adapter from using one address to spend two member
obligations.

### 2.7 Frame locality

A transform through `p` cannot change state reachable only through a disjoint
frame `q`:

```text
p * q defined
transform(state, p, a, v) = state'
-----------------------------------
observe(state, q) = observe(state', q)
```

This is the semantic connection between footprint separation and destructive
Runtime-HIR operations.

## 3. Proof objects

Factoring an authority produces two capabilities and a linear witness:

```text
Cap(F,r,p,E)  p = l * rgt  E = E_l * E_r
------------------------------------------------ partition
Cap(F,r,l,E_l), Cap(F,r,rgt,E_r), Part(F,r,p,l,rgt)
```

`Part` records family, root, parent, ordered children, and the identity of the
factorization. It contains no resource element. A combine consumes the exact
witness and exact child authorities:

```text
Part(F,r,p,l,rgt), Cap(F,r,l,E_l), Cap(F,r,rgt,E_r)
--------------------------------------------------- combine
Cap(F,r,p,E_l * E_r)
```

Matching by footprint alone is insufficient. Two equal extents created by
different resource roots or different factorization events are not the same
permission. The certificate therefore retains produced-value lineage as well as
the family equations.

No operation may fabricate `Part`. It is minted only after the family adapter
validates an exact cover, or by a coherence rewrite over already valid
witnesses.

## 4. Conservation law

Let `Omega(x)` be the multiset of affine and linear ownership obligations inside
analysis value `x`. Every accepted capability operation preserves the multiset
across its consumed inputs and every possible result:

```text
Omega(inputs consumed by an outcome) = Omega(values returned by that outcome)
```

This law is path-sensitive. Alternative success and failure outcomes are checked
separately; their obligations are not added together.

### 4.1 Acquisition and release

```text
acquire_F(Resource(E)) = Cap(F,r,whole_F,E)
release_F(Cap(F,r,whole_F,E)) = Resource(E)
```

An acquisition may copy runtime storage only when `E` is unrestricted. If `E`
contains owned values, acquisition must consume the source and transfer `E`.

Release requires the family's complete root footprint. Releasing an arbitrary
part would discard the complement's authority or expose aliased storage.

### 4.2 Borrowed observation

```text
observe_F(&Cap(F,r,p,E), a) -> &E[a]
```

A source operation may return an ordinary copied value only when the selected
member is unrestricted. A true borrow remains subject to Blot's lexical borrow
rules and cannot escape.

### 4.3 Consuming exchange

Exchange is the ownership-general member update:

```text
exchange_F(!Cap(F,r,p,E), a, !N)
  -> #Exchanged(!E[a], !Cap(F,r,p,E[a := N]))
   | #NotFound(!N, !Cap(F,r,p,E))
```

Both outcomes return every incoming obligation exactly once. The failure outcome
performs no runtime mutation. A discarding write is merely the special case
where the family proves the displaced member unrestricted.

### 4.4 Permutation and structure transforms

A permutation changes positions but not the ownership multiset:

```text
Omega(permute_F(Cap(F,r,p,E), pi)) = Omega(E)
```

A shape transform may change the footprint representation only when it provides
an isomorphism between old and new positions and preserves root identity.

## 5. Coherence of partition trees

Given:

```text
J1 : Part(F,r,abc,a,bc)
J2 : Part(F,r,bc,b,c)
```

left reassociation consumes both and returns:

```text
J4 : Part(F,r,abc,ab,c)
J3 : Part(F,r,ab,a,b)
```

where `ab = a * b`. Right reassociation is the inverse. The generic proof needs
only family equality, exact parent-child identity, and family composition. It
does not need to know whether footprints are intervals, key sets, list segments,
or tree contexts.

Coherence is proof-only:

```text
runtime(reassociate(J1,J2)) = unit
cost(reassociate(J1,J2)) = O(1) analysis, O(0) runtime
```

The checker may normalize proof trees internally, but source-visible witnesses
remain linear values so normalization cannot resurrect a consumed proof.

## 6. Generic operations versus family adapters

| Concern                                 | Generic capability core   | Family adapter                       |
| --------------------------------------- | ------------------------- | ------------------------------------ |
| exclusive use across branches and calls | yes                       | no                                   |
| family/root identity                    | yes                       | supplies identities                  |
| exact-cover witness lifecycle           | yes                       | validates factorization              |
| ownership conservation                  | yes                       | maps positions to member payloads    |
| witness reassociation                   | yes                       | supplies partial composition         |
| address meaning                         | no                        | index, key, path, handle, coordinate |
| bounds/membership proof                 | no                        | family-specific                      |
| runtime representation                  | no                        | Store, links, buckets, nodes, pages  |
| destructive lowering                    | authorizes one occurrence | emits the operation                  |
| acquisition/release cost                | checks transfer safety    | chooses copy/reuse/materialization   |

The division prevents two opposite mistakes:

1. hardcoding every collection into ownership flow; and
2. allowing user code to assert unverified separation facts.

## 7. Candidate family instantiations

### 7.1 Arrays, vectors, buffers, and strings

```text
Foot = half-open interval [lo,hi)
[a,b) * [b,c) = [a,c)
Address = relative integer index
```

This is the current `Slice` adapter. Typed buffers and strings can reuse the
interval algebra, although string addressing must choose bytes, scalar values,
or grapheme clusters and keep that choice stable.

### 7.2 Matrices and tensors

Rectangular tiles compose along one matching face. Axis and shape are part of
the footprint, so equal numeric bounds on different axes do not mix. General
tilings require a partition tree because arbitrary rectangle union is not always
rectangular.

```text
Foot = (shape, axis ranges)
Address = coordinate tuple
```

### 7.3 Linked sequences

A list segment can be identified by root plus ordered endpoint identities. Its
combine proof is a splice boundary or zipper context, not arithmetic adjacency.

```text
Foot = segment(start,end)
Address = cursor or bounded traversal
```

Zero-copy partition additionally requires exclusive links. A persistent list may
implement the same source operation by copying its spine; the ownership algebra
does not promise a particular representation.

### 7.4 Trees

A subtree authority is insufficient to reconstruct the whole tree. Partition
must return the selected subtree, the disjoint remainder or sibling pieces, and
a zipper-shaped witness recording the parent context. Child names or positions
make composition ordered.

```text
Foot = path-indexed subtree or forest
Address = child path
Witness = typed zipper context
```

Rebalancing is a footprint isomorphism and must update witnesses; a stale path
cannot remain authoritative after rotation.

### 7.5 Maps and sets

Stable key sets form a mostly commutative separation algebra:

```text
Foot = finite key set
P * Q defined when P intersect Q = empty
Address = key
```

Hash buckets are a runtime detail and must not be the logical footprint if
rehashing can move them. A range-partitioned ordered map may instead use key
ranges, with explicit treatment of boundary keys.

### 7.6 Arenas and allocators

An arena can partition handle sets, page ranges, or allocation classes. Handle
generation is part of position identity; otherwise a freed and reallocated slot
could satisfy a stale capability.

```text
Foot = set of (slot,generation) or page intervals
Address = generational handle
```

### 7.7 Graphs and DAGs

Graphs are not an immediate instance. Disjoint node sets can still share or
cross edges, and a mutation through one partition may invalidate the other's
adjacency. A valid family must choose and prove one of:

- ownership of nodes plus every incident edge;
- an explicit cut set returned with the partition;
- separate node and edge capabilities; or
- a read-only shared capability combined with exclusive local mutation.

Without such a model, `node-set intersection = empty` does not imply frame
locality. The generic core must reject a graph adapter that proves only node
disjointness.

## 8. Non-goals

This design does not introduce:

- ownership qualifiers into algebraic subtyping;
- lifetime or region parameters in source types;
- user-defined unsafe primitives;
- a promise that every data structure admits zero-copy partition;
- fractional/shared write permissions;
- implicit witness search by equal-looking footprints; or
- a runtime capability object crossing Blot Core Wasm ABI 1.

Read sharing remains ordinary immutable persistence or lexical borrowing.
Concurrent shared mutation would require a different algebra and synchronization
semantics.

## 9. Compiler representation

The ownership implementations should converge on family-tagged analysis values:

```text
Capability {
  family,
  authority,
  members
}

PartitionWitness {
  family,
  parent,
  left,
  right
}
```

The array adapter translates existing `@region.*` calls into these generic
values with `family = array-interval`. Generic ownership operations perform
substitution, branch joining, obligation calculation, witness matching, and
coherence. The adapter alone interprets indexes and lowers Store operations.

Family identity is serialized in closure ownership contracts and is included in
their semantic revision. A cached contract from a compiler that assigned a
different meaning to a family cannot be reused.

The public `Slice` type and API need not change. This is a compiler fact
refactoring that makes the existing proof honest about what is universal and
what belongs to arrays.

### 9.1 First extraction

This PR extracts exact witness combination and proof-tree reassociation into
`src/linear/partition.ts` and `compiler/src/partition.rs`. Those modules are
parameterized by family and footprint and contain no Slice, Store, interval, or
index operation. The existing Region ownership fact is the array-interval
adapter that supplies produced-value equality and composition.

The law tests instantiate the same core with both ordered intervals and disjoint
map key sets. The map model is evidence about the abstraction, not a new source
feature or runtime implementation. Adding the second production family still
requires family-tagged serialized `Produced` values, its adapter, the full
registration suite below, and Node/Rust parity. This PR deliberately does not
generalize the trusted registry into a source extension mechanism.

## 10. Registration requirements

A future production family is accepted only after Node and Rust independently
test all of the following:

1. family and root separation;
2. disjointness and exact cover for every partition constructor;
3. unit and associativity on admitted footprints;
4. deterministic focus and frame locality;
5. success and failure ownership conservation;
6. exact witness consumption and rejection of stale or foreign witnesses;
7. reassociation and inverse coherence;
8. acquisition/release behavior for unrestricted and owned members;
9. proof erasure and ABI refusal for live capabilities or witnesses;
10. runtime observations and strict Node/Rust parity; and
11. an explicit cost model distinguishing semantic guarantees from optimized
    representation reuse.

Passing only examples is insufficient. Each adapter requires law tests over a
generated or exhaustively bounded footprint domain plus end-to-end catalog
programs.
