# Partitioned ownership regions

Status: experimental design. This document is deliberately ahead of
`LANGUAGE.md`; nothing here is a source-language guarantee until the compiler
implementation and preservation tests land.

The motivating program is in-place divide-and-conquer over a Store. Quicksort
should be able to partition one uniquely owned array, split the permission to
mutate that allocation into two disjoint slices, recursively sort both slices,
and rejoin the permission without copying the array.

The design goal is broader than arrays. The reusable compiler concept is a
**partitioned ownership capability**: one linear authority names a region of one
runtime origin; a trusted partition operation may consume that authority and
produce authorities for a disjoint cover of it. Ordinary values remain pure and
copyable. Only an authority grants destructive access.

This keeps regions out of algebraic subtyping and preserves Blot's existing
separation between value typing and ownership flow.

## 1. Why `@array.split` is not the primitive

`@array.split` already has the right ownership *shape*: it consumes one array
value and makes the selected value and both remainders explicit. Its current
runtime meaning is nevertheless a value split. Lowering allocates and grows new
Stores for the prefix and suffix.

An owned slice needs a different meaning:

```text
Store S = [ a b c d e f g h ]
          ^                 ^
          0                 8

Own(S, [0,8))
       |
       | split 3
       v
Own(S, [0,3))   Own(S, [3,8))
```

The two results intentionally alias the same allocation. Their *write
authority* does not alias.

## 2. Keep the authority separate from value typing

Write a region authority as

```text
Own(origin, region)
```

where `origin` identifies one runtime resource and `region` is a member of a
resource-specific region algebra. For an array Store the region is a half-open
integer interval `[start,end)`.

`Own` is not a source type constructor. It is an ownership fact, like the
existing linear/affine/borrow facts, and is published in a certificate after
ordinary inference succeeds.

A source value that carries `Own(S,R)` is linear. Copying its ordinary runtime
representation is not itself dangerous; the backend may perform a destructive
operation only when a verified certificate proves that the consuming source
occurrence carries the matching authority.

This point is important for compositionality. The language does not need
lifetime variables, region variables in the type lattice, or an affine subtype
of arrays. A library may expose a slice-shaped value while the compiler tracks
its authority separately.

## 3. Region algebra

The first implemented region family is an array interval:

```text
Region(S) = { [lo,hi) | 0 <= lo <= hi <= len(S) }
```

with disjointness

```text
[lo1,hi1) # [lo2,hi2)
  iff hi1 <= lo2 or hi2 <= lo1
```

and ordered composition

```text
[lo,mid) + [mid,hi) = [lo,hi)
```

The compiler should not hard-code this algebra into general ownership flow.
Instead, each trusted partition primitive publishes which region family it
uses. Later region families can have their own checked split/join laws without
changing ordinary subtyping.

The invariant for every runtime origin is:

> All simultaneously live write authorities for that origin are pairwise
> disjoint.

Read-only aliases to the underlying value are permitted. Persistent operations
remain persistent. A destructive operation needs a matching live authority.

## 4. Proposed intrinsic boundary

The surface API should be prelude wrappers. The `@` operations are the small
trusted boundary that the checker and Runtime HIR validator recognize.

Names below are provisional.

### `@region.array.claim`

Consumes unique ownership of an array and returns an authority for its complete
Store:

```text
!array : [A]
------------------------------- claim
slice : Slice A   carries Own(S,[0,len(S)))
```

The operation is O(1). It does not copy the Store.

Claim **must not** accept an unrestricted shared array merely because this call
is its syntactic last use. The authority must come from a per-path consuming
ownership proof. Otherwise another alias could observe a later destructive
write.

### `@region.split`

For a slice with length `n`, splitting at `k` succeeds when `0 <= k <= n`:

```text
Own(S,[lo,hi))   k = mid - lo
0 <= k <= hi-lo
------------------------------------------------ split
Own(S,[lo,mid)) * Own(S,[mid,hi))
```

The parent authority is consumed. The result authorities are independent linear
obligations. The runtime operation changes metadata only.

A failed split returns the original authority unchanged. No failing operation
may silently consume authority:

```text
#Split (left, right)
| #SplitOutOfBounds original
```

### `@region.join`

Consumes two authorities and succeeds only when they have the same origin and
are adjacent in the written order:

```text
Own(S,[lo,mid)) * Own(S,[mid,hi))
--------------------------------- join
Own(S,[lo,hi))
```

A failed join returns both inputs unchanged.

Adjacency is sufficient; the two authorities need not be immediate siblings of
one earlier split. This permits reassociation:

```text
([a,b) + [b,c)) + [c,d)
  == [a,b) + ([b,c) + [c,d))
```

without inventing overlap.

### `@region.array.get`

Borrows an authority and reads relative to it. A proved form may lower directly
to `store.read`; a total form returns `Option`.

```text
&Own(S,[lo,hi))   0 <= i < hi-lo
-------------------------------- get
S[lo+i]
```

The authority is unchanged.

For an element that itself carries an ownership obligation, ordinary copying is
still forbidden. A later consuming `take` operation can transfer an element's
obligation without weakening this rule.

### `@region.array.set`

Consumes an authority and returns authority for the same interval:

```text
Own(S,[lo,hi))   0 <= i < hi-lo
-------------------------------- set
Own(S,[lo,hi))
```

The Runtime HIR operation may write `S[lo+i]` in place because the certificate
proves no live write authority covers that location.

Replacing an element that itself owns a resource needs the same consuming
semantics as today's owned-array replacement rules. The first implementation
may therefore restrict `set` to unrestricted element ownership and add a
consuming replacement operation separately.

### `@region.array.swap`

Consumes one authority and swaps two positions in that region:

```text
Own(S,R)   i in R   j in R
-------------------------- swap
Own(S,R)
```

This operation is useful enough to deserve one trusted primitive. It moves two
slots internally and never copies either value, so it also gives a future path
to sorting arrays whose elements carry obligations.

### `@region.array.freeze`

Relinquishes destructive authority and returns an ordinary persistent array.
It is accepted only for the full region of the origin:

```text
Own(S,[0,len(S)))
----------------- freeze
[A]
```

This is the boundary from unique/destructive semantics back to ordinary Blot
value semantics. It is O(1).

The ownership checker still requires every other linear authority to be
consumed. The runtime validator additionally requires the region being frozen to
cover the complete Store.

## 5. Source-facing `Slice`

A prelude API can make the intrinsics read as ordinary Blot:

```blot
let Slice = {
  .claim = fn !values => @region.array.claim values;
  .split = fn (!slice, index) => @region.split (slice, index);
  .join = fn (!left, !right) => @region.join (left, right);
  .get = fn (&slice, index) => @region.array.get ((&slice), index);
  .set = fn (!slice, index, value) =>
    @region.array.set (slice, index, value)
  ;
  .swap = fn (!slice, left, right) =>
    @region.array.swap (slice, left, right)
  ;
  .freeze = fn !slice => @region.array.freeze slice;
}
```

The exact runtime representation of `Slice A` is compiler-private. Source code
cannot project the backing Store out of a slice and then use whole-array
mutation to escape the region bound.

A private representation may be `(store,start,length,extent)`. That layout is
not part of the source type and does not cross ABI 1.

## 6. Ownership-certificate extension

Today's ownership certificate records a binding identity, consuming source
spans, and structural extraction lineage. Region authority adds a second kind of
lineage: **partition lineage**.

A certificate entry for a live or transferred authority needs enough evidence
to replay these events:

```text
claim(origin_binding, use_span) -> permit p0
split(p0, split_span)            -> p1, p2
write(p1, write_span)            -> p3
join(p3, p2, join_span)          -> p4
freeze(p4, freeze_span)
```

The verifier checks the linear graph:

1. every permit is produced exactly once;
2. every permit is consumed at most once;
3. `split` consumes one and produces exactly all declared parts;
4. `join` consumes every declared input and produces one;
5. write/swap consume one and produce one successor;
6. freeze consumes one and produces no authority;
7. a claim is rooted in a verified per-path ownership consumption of the
   matching source resource; and
8. no operation cites a permit from another module path or binding identity.

The runtime validator checks facts that depend on dynamic integers or concrete
layout: split bounds, join origin/adjacency, relative access bounds, and full
coverage at freeze.

The split of responsibility is intentional. The certificate proves *where the
exclusive authority came from and that it was not duplicated*. Runtime HIR
validation proves *that the dynamic region transformation described by the
trusted primitive is a valid partition*.

## 7. Preservation argument

Let `Live(S)` be the set of interval authorities live for Store `S`.

The safety invariant is:

```text
forall R1 != R2 in Live(S). disjoint(R1,R2)
```

Initially, claim introduces exactly `[0,len(S))`, so the invariant holds.

### Split

Replacing `[lo,hi)` with `[lo,mid)` and `[mid,hi)` preserves the invariant:

- both children are subsets of the parent;
- the children are disjoint; and
- every authority previously disjoint from the parent is disjoint from both
  children.

### Join

Replacing adjacent `[lo,mid)` and `[mid,hi)` with `[lo,hi)` preserves the
invariant because any other live interval was disjoint from *both* inputs. An
interval overlapping their union would overlap at least one input.

### Write and swap

A write is restricted to a location inside one live authority. Every other live
write authority is disjoint, so no other authority can authorize access to that
location. Consuming and recreating the same authority preserves `Live(S)` as a
set.

### Freeze

Freezing the full interval consumes destructive authority before exposing the
ordinary array. Since future persistent writes do not use region authority, no
later destructive observation is possible through that permit.

Therefore every destructive Store operation authorized by a valid region
certificate is observationally equivalent to the corresponding persistent
operation for programs accepted by ownership checking.

That final sentence is the compiler theorem we need: reuse changes allocation
identity, not source-visible values.

## 8. Failure conservation

Every operation that can fail at run time must return all authority it received.
This is not ergonomic decoration; it is required for preservation.

Bad:

```text
split : Own R -> Result (Own L * Own R) Error
```

The error arm lost the original owner.

Required:

```text
split : Own R -> Split (Own L) (Own R) | OutOfBounds (Own R)
```

Likewise a failed join returns both input authorities, and a failed checked
write returns the original authority.

This mirrors `@array.take` and `@array.split`, where failure returns the original
array rather than dropping it.

## 9. Empty regions

Splitting at either endpoint creates an empty authority. Empty intervals grant
no write location, but they remain linear values and must still be consumed.

This is useful: algorithms do not need special cases merely to keep ownership
balanced.

The first implementation should require `freeze` to receive the only live
permit for the origin, not merely a numerically full interval. That stronger
rule catches a forgotten empty sibling and makes the ownership/runtime boundary
easy to audit. If later evidence shows this restriction inconvenient, allowing
full freeze beside empty permits is a safe relaxation provided those permits
remain unusable for memory access and are still consumed before scope exit.

## 10. Quicksort shape

With the above API, quicksort never allocates an element Store after claim:

```blot
let quicksort =
  rec (fn !slice =>
    if Slice.length (&slice) <= 1:
      return slice

    let (slice, pivot) = partition slice

    let #Split (left, rest) = Slice.split (slice, pivot)
    let #Split (middle, right) = Slice.split (rest, 1)

    let left = quicksort left
    let right = quicksort right

    let slice = Slice.join (left, middle)
    return Slice.join (slice, right)
  )
```

`partition` uses `Slice.swap`; split/join only rewrite metadata. The two
recursive calls own disjoint regions of one Store.

A sequential backend may call them one after another. A future parallel backend
has explicit evidence that the two write sets are disjoint; no new source
semantics are required.

## 11. Non-goals for the first patch

- no source-visible pointers;
- no lifetime parameters;
- no general mutable references;
- no ABI representation for slices;
- no claim from unrestricted shared arrays;
- no arbitrary user-defined partition proof accepted on trust; and
- no parallel execution merely because regions are disjoint.

The first patch should establish the algebra and certificate boundary with an
executable model before production lowering is taught the new operations.
