# Partitioned ownership regions

Status: experimental design. This file is deliberately ahead of `LANGUAGE.md`.
The executable probes live in `experiments/owned-regions/`. Nothing here is a
supported source-language rule until checker, Runtime HIR, evaluator, Wasm, and
preservation gates agree.

The motivating program is quicksort over one Store. Partitioning should
rearrange one backing allocation, split permission to mutate it into disjoint
child regions, recurse over the children, and rejoin the permission without
copying the array at each recursive step.

The useful compiler concept is broader than arrays:

> A **partitioned ownership authority** is a linear capability naming one region
> of one private runtime resource. A trusted partition consumes one authority
> and produces authorities for a disjoint cover. A trusted combine consumes
> compatible authorities and produces their union.

The design keeps this authority out of algebraic subtyping. Ordinary value types
still describe values; ownership and region facts are independently checked and
published as replayable evidence.

## 1. Three proof layers

An earlier version of this proposal conflated linearity with memory uniqueness.
That is not sound enough.

Consider:

```blot
let shared = [1, 2, 3]
let !candidate = shared
```

The `!` marker constrains how `candidate` is consumed. It does not, by itself,
prove that `shared` cannot still denote the same persistent Store. Therefore a
compiler may not destructively reuse the Store merely because `candidate` is
linear.

The complete argument has three independent layers:

```text
Store provenance
    -> region-authority graph
        -> region-family geometry
            -> destructive Runtime-HIR operation
```

### 1.1 Store provenance

A **Store root** proves that an allocation has no source-visible persistent
alias which can observe a destructive update.

The easiest root is a fresh allocation. A compiler optimization may also
preserve a root through operations whose existing ownership/reuse proof shows
that the old Store is consumed and no observer survives.

Store roots are not invented by the region checker. A region claim either
creates a fresh root by copying, or consumes a separately verified root when the
compiler chooses zero-copy reuse.

### 1.2 Authority graph

Once a private root exists, the region certificate proves that authority derived
from it is linear:

```text
claim(root, origin, family) -> p
partition(p)                -> [p1, ..., pn]
combine([p1, ..., pn])      -> p
transform(p)                -> p'
release(p)
```

No permit may be produced twice, consumed twice, reused after partition, or
combined with a permit from another root/origin/family.

This proof is implemented independently in `src/linear/region_certificate.ts`.

### 1.3 Region-family geometry

The authority graph intentionally knows nothing about what a region means. A
family validator proves the resource-specific laws.

The first family is an array interval. Its validator is
`src/linear/region_interval.ts`.

This split is the compositional part of the design. A future matrix tile, arena
segment, byte-buffer range, or record-field partition can reuse the authority
graph while supplying a different region algebra.

## 2. Array interval algebra

For a Store `S` of extent `n`, an interval region is:

```text
R = [lo, hi)
0 <= lo <= hi <= n
```

Two non-empty intervals for one origin are disjoint iff:

```text
hi1 <= lo2 || hi2 <= lo1
```

Empty intervals authorize no location and are disjoint from every interval.

The invariant is:

> All simultaneously live write authorities for one origin are pairwise
> disjoint.

Ordered composition is:

```text
[lo, mid) + [mid, hi) = [lo, hi)
```

A split at relative offset `k` is valid when `0 <= k <= hi - lo` and produces:

```text
[lo, lo+k)   [lo+k, hi)
```

The outputs are a disjoint exact cover of the input.

## 3. `claim` has safe copy semantics

The source-facing operation should be general:

```text
claim : [A] -> Slice A
```

Its semantic meaning is:

1. create a private Store initialized with the input array's elements;
2. create the full authority `[0,len)` over that Store; and
3. return a linear slice carrying that authority.

This meaning is sound even when the source array is shared: the private Store is
a fresh allocation and any old alias observes the old Store.

The compiler may optimize the copy away only when Store provenance already
proves that the input Store is uniquely reusable. In that case the claim
transfers that root into region authority instead of allocating a new Store.

Thus there are two implementation paths with one source meaning:

```text
unknown/shared input
  array --copy--> fresh private Store --claim--> Slice

proved unique input
  array ---------reuse root-----------> Slice
```

Allocation identity is not source-observable, so the paths are equivalent for an
accepted program.

This makes slices useful compositionally without requiring callers to express a
new uniqueness type. It also gives optimization a precise proof obligation:
zero-copy claim is allowed only with verified Store provenance.

## 4. Proposed trusted intrinsic boundary

Names are provisional. Prelude wrappers should own the application-facing API;
`@region.*` is the small compiler boundary.

### `@region.array.claim`

Creates a full array-interval authority. The evaluator may implement the
semantic copy directly. Runtime HIR may choose either `fresh` or proof-backed
`reuse`.

The result is a private slice value and a linear authority:

```text
Slice(S, 0, len(S))  carries Own(root, origin, [0,len(S)))
```

A `reuse` lowering must cite a verified Store root. A `fresh` lowering creates a
new root and needs no prior uniqueness fact.

### `@region.split`

Consumes one authority and, on success, produces two child authorities:

```text
Own(S,[lo,hi))   0 <= k <= hi-lo
---------------------------------
Own(S,[lo,lo+k)) * Own(S,[lo+k,hi))
```

The runtime operation is metadata-only.

Failure returns the original authority:

```text
#Split (left, right)
| #SplitOutOfBounds original
```

No element Store is copied.

### `@region.join`

Consumes two authorities. Success requires one root, origin, family and extent,
plus ordered adjacency:

```text
Own(S,[lo,mid)) * Own(S,[mid,hi))
---------------------------------
Own(S,[lo,hi))
```

The inputs need not be immediate siblings of one earlier split. Adjacency is
enough, which permits reassociation of nested partitions.

Failure returns both authorities unchanged.

### `@region.array.length`

Borrows a slice and returns its region length. It changes no authority.

### `@region.array.get`

Borrows a slice and reads relative to its start. A proved form can lower
directly to `store.read`; a total wrapper can return `Option`.

```text
&Own(S,[lo,hi))   0 <= i < hi-lo
---------------------------------
S[lo+i]
```

Reading an element that itself carries an ownership obligation must still obey
the existing no-copy rule. Region authority does not make owned elements
copyable.

### `@region.array.set`

Consumes one authority and returns its successor over the same interval:

```text
Own(S,R)   i in R
-----------------
Own(S,R)
```

The backend may destructively write because the root proof excludes persistent
observers and the region proof excludes overlapping write authorities.

The first implementation may restrict replacement to unrestricted element
ownership; moving/replacing owned elements needs a consuming element operation.

### `@region.array.swap`

Consumes one authority, swaps two in-range positions, and returns the successor
authority over the same interval.

This deserves a trusted primitive because it moves slots without copying either
value. It is the core update for in-place quicksort and remains viable if array
elements later carry obligations.

### `@region.array.freeze`

Consumes the sole live full-region authority and returns an ordinary persistent
array:

```text
Own(S,[0,len(S)))
------------------
[A]
```

No destructive authority survives. The first implementation requires this permit
to be the only live permit for the origin, including empty permits.

`freeze` intentionally drops uniqueness provenance at the source boundary. A
later `claim` is always semantically valid by copying and may reuse again only
if a separate Store-provenance analysis re-establishes uniqueness.

## 5. Source-facing `Slice`

A prelude wrapper can keep application code ordinary:

```blot
const Slice = {
  .claim = fn values => @region.array.claim values;
  .length = fn &slice => @region.array.length (&slice);
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

The exact syntax depends on how private values are surfaced to inference. The
important rule is that source code cannot project the backing Store from a slice
and then bypass region-relative mutation.

A Runtime-HIR representation may be `(store,start,length,extent)` or equivalent,
but that layout is compiler-private and refused by ABI 1.

## 6. Generic authority certificate

The implemented draft certificate receives a set of Store roots already
validated by the surrounding compiler. A claim must cite one of them.

For every event stream it checks:

1. every root is claimed at most once in that certificate;
2. every acquisition origin is claimed at most once;
3. every permit id is produced once;
4. every permit is consumed at most once;
5. partition consumes its source and produces all declared parts;
6. combine consumes all inputs and requires one root/origin/family;
7. transform consumes one permit and produces one successor on the same
   root/origin/family;
8. release consumes a permit and produces none; and
9. a closed certificate has no live leaf permits.

This verifier does **not** accept an arbitrary root string as evidence.
Production Runtime HIR must supply the authorized-root set from fresh allocation
or a verified destructive-reuse provenance proof.

The executable model creates its root from the fresh Store allocated by `claim`,
then independently replays the authority graph at `freeze`.

## 7. Family validation

For array intervals, Runtime HIR additionally checks:

- every interval lies inside its Store extent;
- split outputs are an exact ordered cover of the input;
- simultaneously live intervals are pairwise disjoint;
- join inputs have one origin/extent and are adjacent;
- relative access maps to an address inside the interval; and
- freeze receives the sole live full interval.

The pure implementation in `src/linear/region_interval.ts` is intended to be
reused by the production validator rather than re-derived in multiple backends.

## 8. Failure conservation

Every operation that may fail at run time must return all authority it received.
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

No authority event is recorded for a failed operation because no authority
transition occurred.

## 9. Preservation argument

Assume a valid Store root `root` for allocation `S`, meaning no persistent
source-visible alias may observe destructive changes to `S` while the root is
active.

Let `Live(S)` be the set of interval authorities currently live for that root.
Maintain:

```text
forall R1 != R2 in Live(S). disjoint(R1,R2)
```

### Claim

Fresh claim creates a new Store, so the root premise holds by construction.
Reuse claim is admitted only with external Store-provenance evidence. In either
case `Live(S)` begins as one full interval.

### Split

Replacing `[lo,hi)` with `[lo,mid)` and `[mid,hi)` preserves pairwise
disjointness because both children are subsets of the parent and disjoint from
each other.

### Join

Replacing adjacent `[lo,mid)` and `[mid,hi)` with `[lo,hi)` preserves the
invariant: any third live interval overlapping the union would have overlapped
at least one input.

### Set/swap

The operation touches only addresses inside one live interval. Every other live
write authority is disjoint, and the Store root excludes persistent observers.
Consuming the permit and producing a same-region successor preserves `Live(S)`.

### Freeze

Freeze consumes the sole full authority before exposing the ordinary persistent
array. Therefore no destructive permit remains able to change the Store after it
becomes generally shareable again.

Hence a destructive operation authorized by all three proof layers is
observationally equivalent to the persistent semantics: allocation identity may
change, source-visible values do not.

## 10. Quicksort

The executable experiment uses Lomuto partitioning with `swap`. Its logical
shape is:

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

The element Store is never copied during partition, split, recursion, or join.
The only possible O(n) acquisition copy is at the outer `claim`; that copy is
elided when Store provenance proves the input can be stolen safely.

This gives a useful performance contract:

```text
shared/unknown input: at most one O(n) acquisition copy + in-place quicksort
proved unique input: zero acquisition copy + in-place quicksort
```

The two recursive calls own disjoint regions. A sequential backend simply calls
them in order. A future parallel backend could use the same disjointness
evidence without changing source semantics.

## 11. Why this is not general mutable references

The proposal does not introduce arbitrary addresses that can be stored,
returned, compared, or aliased. A slice is a private resource view with a
compiler-known region family and linear authority transitions.

That restriction keeps the proof local:

- no lifetime parameters;
- no alias search through arbitrary heap graphs;
- no mutable-reference subtype relation; and
- no region variables inside algebraic type inference.

A new proof-producing collection can reuse the generic authority graph only
after it supplies trusted partition/combine/transform laws for its own family.

## 12. Production gates

Before moving any of this into `LANGUAGE.md`, require:

- Store-provenance tests proving zero-copy claim is denied when an older
  persistent alias could observe the Store;
- a copy fallback proving `claim` remains semantically valid for shared inputs;
- authority-certificate tamper tests, including duplicate root/origin/permit
  claims and use-after-partition;
- family tests for exact split cover, adjacency, bounds, empty intervals, and
  full freeze;
- failure-conservation tests on every total operation;
- evaluator/Runtime-HIR/Wasm agreement;
- ABI refusal for live slice values;
- an in-place quicksort corpus entry whose recursive split/join path allocates
  no element Stores; and
- a benchmark distinguishing acquisition copy cost from partition/sort cost.

Until those gates pass, `@region.*` remains an experimental trusted boundary,
not part of Blot's implemented language.
