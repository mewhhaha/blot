# Owned ordered text maps

## Status and scope

This document is an implementation contract for the first map-shaped source API
built over partitioned interval ownership. Source syntax and ordinary type rules
remain in [`LANGUAGE.md`](../LANGUAGE.md), subject to
[`COHERENCE.md`](COHERENCE.md).

`OrderedTextMap` is a finite map from `Text` to one unrestricted value type. It
uses the production array-interval capability family; it is not a separate
compiler family.

## 1. Representation

`OrderedTextMap.entry V` is the ordinary two-slot product `(Text,V)`. The
persistent representation is:

```text
[(Text,V)]
```

The owned representation is a `Slice` of the same entries:

```text
OrderedTextMap.of V = Slice.of (OrderedTextMap.entry V)
```

For a root Store `S`, the abstract-map protocol invariant is:

```text
ordered(S) iff
  for every 0 <= i < j < length(S),
  Text.cmp key_i key_j = #Less
```

Strict ordering implies key uniqueness and permits binary search and contiguous
key-range partition.

## 2. Type versus protocol invariant

The carrier is structural. The ordinary type `OrderedTextMap.of V` proves only
that the value has the same authority representation as the corresponding
`Slice`; it does not prove `ordered(S)`.

`OrderedTextMap.copy` dynamically validates ordering before minting the abstract
map result. Every exported map operation preserves it. Therefore lookup,
key-range, and logarithmic-cost theorems in this document are conditional on the
protocol premise:

```text
map descends from copy and exported OrderedTextMap operations
```

A caller can deliberately pass a structurally matching raw `Slice`. This cannot
forge interval authority, enlarge a footprint, or cause memory unsafety. It is,
however, outside the abstract ordered-map contract: binary search on an
unordered carrier need not equal mathematical map lookup, and the map-level cost
and result theorems do not apply.

A total abstraction over every well-typed inhabitant would require a nominal
seal or revalidation at each public operation. The current adapter deliberately
chooses a source-level protocol instead.

## 3. Public operations

```text
validate
  : &[(Text,V)] -> Bool

copy
  : [(Text,V)] -> OrderedTextMap.of V
  traps when keys are not strictly increasing

length
  : &OrderedTextMap.of V -> Int

get
  : (&OrderedTextMap.of V, Text) -> Option V

replace
  : (!OrderedTextMap.of V, Text, V)
  -> #MapReplaced (V, !OrderedTextMap.of V)
   | #MapMissing (V, !OrderedTextMap.of V)

split_before
  : (!OrderedTextMap.of V, Text)
  -> #Split (!OrderedTextMap.of V,
             !OrderedTextMap.of V,
             !Rejoin)
   | #SplitOutOfBounds (!OrderedTextMap.of V)

join
  : (!Rejoin,
     !OrderedTextMap.of V,
     !OrderedTextMap.of V)
  -> !OrderedTextMap.of V

freeze
  : !OrderedTextMap.of V -> [(Text,V)]
```

The signatures are explanatory ordinary types plus ownership modes; ownership
remains outside the subtype lattice.

## 4. Value-domain restriction

`get` borrows the map authority. The current source language has no field borrow
that can inspect an entry key without also producing or observing its value.
Consequently the first adapter admits only `V` with no affine or linear
obligation.

This restriction applies to acquisition validation, binary search, borrowed
lookup, and value replacement. Extending the adapter to owned values requires a
checked key-only projection or a dedicated family operation. Weakening the
generic borrowed-read rule would permit copying an owned payload and is unsound.

## 5. Acquisition

`validate` performs a non-trapping strict-order check over the persistent input.
`copy` performs the same check and traps before authority acquisition when it
fails.

On success:

```text
strictly_ordered(entries)
--------------------------------
copy(entries) : MapRange(S,0,n)
```

where:

```text
MapRange(S,lo,hi) = IntervalAuthority(S,lo,hi) + ordered(S)
```

The compiler proves and tracks only the interval authority. `ordered(S)` is the
source adapter's protocol fact established by validation and preserved by its
exports.

`Slice.copy` retains its ordinary acquisition behavior: it copies persistent
storage unless a separate ownership/reuse proof permits Store reuse. The
ordering check itself grants no reuse authority.

## 6. Borrowed observation

For a valid map protocol value:

```text
MapRange(S,lo,hi) |- get(key) : Option V
```

Binary search reads only entries in `[lo,hi)`. It changes neither Store contents
nor ownership authority.

Deterministic focus follows strict ordering. A present key has one position; an
absent key has one lower-bound insertion point. The operation never treats an
equal-looking Store root or sibling interval as the current map.

## 7. Value replacement

Keys are immutable. If binary search focuses position `i`, replacement writes:

```text
(key_i, replacement)
```

using the stored key, not the query spelling. This preserves strict ordering
even for a future comparator whose equality relation admits multiple
representations. The current adapter uses exact text comparison.

Ownership conservation is path-sensitive:

```text
MapRange(S,lo,hi) * replacement
------------------------------------------------ success
old_value * MapRange(S[value_i := replacement],lo,hi)
```

```text
MapRange(S,lo,hi) * replacement
------------------------------------------------ missing
replacement * MapRange(S,lo,hi)
```

Success returns the displaced value. Failure returns the uninstalled replacement
and performs no write. No incoming obligation disappears merely because the key
was absent.

## 8. Why key mutation is absent

Changing, inserting, deleting, or reordering a key can invalidate:

- strict ordering and uniqueness;
- a lower-bound result used by a live split;
- the logical key range named by a sibling authority;
- frame locality for a sibling operation; and
- exact witness reconstruction.

The first adapter therefore exposes value replacement only. An insertion or
removal operation would require complete-root authority plus a
footprint-changing proof and possibly a new allocator or tree/page
representation. It is not hidden inside `replace`.

## 9. Partition by key

`split_before map key` computes:

```text
mid = lower_bound(S, lo, hi, key)
```

and delegates to interval partition:

```text
[lo,hi) = [lo,mid) * [mid,hi)
```

Under `ordered(S)`, the left child contains keys strictly less than `key`, and
the right child contains keys greater than or equal to `key`. The same generic
partition witness remains sufficient; no second run-time map witness is minted.

The lower bound is always in `[lo,hi]`, so a checked implementation cannot fail
because of an invalid midpoint. The source wrapper retains the conservative
failure branch of `Slice.split` so authority conservation remains explicit if a
lower layer reports failure.

## 10. Join and reassociation

`join` consumes the exact witness and exact sibling authorities produced by the
split. Equal bounds under another Store, another split event, or another
produced-value lineage are rejected.

The array-interval family admits the stronger adjacent-interval associativity
law, so its witness reassociation operations can rotate valid adjacent segment
trees without inspecting map keys. The generic capability algebra does not infer
this law for every family.

The ordering protocol is global to the Store and is unchanged by split, join, or
witness reassociation because none mutates entries.

## 11. Freeze

`freeze` is defined only for complete-root authority. It delegates to
`Slice.freeze`, releasing exclusive Store authority and returning an immutable
persistent array.

Freezing a partial map would expose one slice while complement authority remains
live. It is therefore rejected by the underlying root proof.

The resulting array remains strictly ordered when the protocol premise held, but
ordinary array typing does not retain an abstract `OrderedTextMap` proof.
Reacquiring the map API through `copy` validates again.

## 12. Compiler trust boundary

The trusted compiler fact is only the registered `array-interval` capability:

- root identity;
- interval footprint;
- exact split/join witness;
- member focus and bounds; and
- ownership conservation.

The compiler does not add `ordered(S)` to `Phi`, infer it from the structural
type, or recognize an `OrderedTextMap` source binding name. The source prelude
establishes and preserves the protocol through its implementation.

A map operation may use a trusted interval primitive internally, but it receives
no special syntax, type-lattice node, Runtime-HIR operation, ABI type, or
primitive registry entry merely for convenience.

## 13. Family status

At the public source layer, ordered maps are a distinct collection abstraction.
At the compiler proof layer, they remain array intervals with a checked
source-level protocol invariant.

A true key-set family would authorize arbitrary disjoint subsets independently
of physical order. It would require:

- stable comparator and key identity;
- family-tagged serialized ownership values;
- a run-time representation for non-contiguous membership; and
- its own focus, frame, split, join, and cost validation.

This adapter chooses ordered contiguous ranges to reuse the current Store
representation.

## 14. Cost model

For a valid `ordered(S)` protocol value with `n` entries:

| Operation    |                                                                Work | Element Store copies after acquisition |
| ------------ | ------------------------------------------------------------------: | -------------------------------------: |
| validation   |                                             `O(n)` text comparisons |                                      0 |
| copy         | `O(n)` explicit acquisition; `O(1)` only under separate reuse proof |                   at most 1 full Store |
| length       |                                                              `O(1)` |                                      0 |
| get          |                                              `O(log n)` comparisons |                                      0 |
| replace      |                      `O(log n)` comparisons plus `O(1)` owned write |                                      0 |
| split_before |                         `O(log n)` comparisons plus `O(1)` metadata |                                      0 |
| join         |                                                     `O(1)` metadata |                                      0 |
| freeze       |                                 `O(1)` Store release in Runtime HIR |                                      0 |

These complexity claims are conditional on strict ordering. They do not apply to
a raw structurally matching unordered Slice.

The existing persistent `Map.with equal` is an association array with linear
lookup and rebuilding update. A benchmark compares equal abstract semantics over
already ordered unique text keys and reports acquisition separately so the
one-time validation/copy cost is visible.

Wall-clock speedup is evidence, not a language guarantee. The semantic
performance contract is that successful owned replacement lowers to one
ownership-authorized Store write and performs no persistent element-Store copy.

## 15. Production gates

The adapter is production-complete only when Node and Rust/Wasm agree on:

1. non-trapping validation;
2. successful acquisition and trapping invalid acquisition;
3. empty, singleton, boundary, present, and absent lower bounds;
4. rejection of value domains with owned obligations;
5. success and failure replacement conservation;
6. split/join/reassociation witness exactness;
7. partial-freeze and stale/foreign-witness rejection inherited from `Slice`;
8. proof erasure and ABI behavior;
9. deterministic generated-prelude output;
10. Store-write classification and cost evidence; and
11. an adversarial raw-Slice case demonstrating memory safety without claiming
    ordered-map result correctness.

No production test may turn the protocol premise into an unstated
structural-type fact.
