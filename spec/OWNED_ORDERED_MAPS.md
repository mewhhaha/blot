# Owned ordered text maps

Status: implementation contract. The source rules are normative in
`LANGUAGE.md`; this document owns the representation invariant, proof
refinement, and cost model for the first non-array collection API built over
partitioned ownership.

## 1. Scope

`OrderedTextMap` is a finite map from `Text` to one value type.
`OrderedTextMap.entry V` is an attached structural product type whose storage is
the ordinary two-slot tuple, so its persistent representation is:

```text
[(Text, V)]
```

whose keys are strictly increasing under `Text.cmp`. Strict ordering implies
uniqueness. The owned representation is a `Slice.of (OrderedTextMap.entry V)`,
but its public operations expose keys and values rather than positional
mutation.

This is deliberately a source adapter, not a new primitive family. The trusted
`@region.*` boundary already provides private Store acquisition, interval
partition, exact witnesses, element replacement, and proof erasure. A sorted map
refines those intervals into key ranges:

```text
Store interval [lo, hi)
        refines
keys [entry(lo).key, entry(hi).key)
```

The refinement is sound because no owned-map operation can change, insert,
remove, or reorder a key.

The first adapter fixes the key type to `Text`. A generic comparator is not
accepted until the compiler can prove comparator identity and total-order laws
across acquisition and every later operation. Treating two equal-looking
closures as the same ordering would make binary search and range partition
unsound.

## 2. Representation invariant

For an owned map over Store `S`, every entry in the full root satisfies:

```text
entry(i) = (key_i, value_i)
0 <= i < len(S)
i < j  implies  Text.cmp key_i key_j = #Less
```

Consequences:

1. every key occurs at most once;
2. binary search has a deterministic focus;
3. every interval authority names one contiguous key range;
4. two sibling interval authorities authorize disjoint key sets;
5. joining siblings restores the parent's exact key range; and
6. value replacement preserves every fact above.

The invariant is checked before `Slice.copy`. `validate` provides a non-trapping
preflight. `copy` traps before minting authority when validation fails; on
success it returns the full root directly so the ordinary closure ownership
contract preserves the full-root freeze proof.

## 3. Public authority and operations

`OrderedTextMap.of V` is the linear region authority represented by
`Slice.of (OrderedTextMap.entry V)`.

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

`get` borrows the authority. As with `Slice.get`, the ownership checker rejects
a borrowed read that would copy an owned value. The first adapter therefore
admits only values carrying no affine or linear obligation: acquisition
validation and binary search inspect an entry pair in order to read its key, and
the current source language has no field-borrow operation that can project the
key without also producing the value.

`replace` still conserves both sides: success returns the displaced value and
failure returns the uninstalled replacement. Extending it to owned values
requires a checked key-only projection or a dedicated family adapter; weakening
the borrowed-read rule would be unsound.

`split_before map key` splits at the lower bound of `key`. The left result
contains keys strictly less than `key`; the right contains keys greater than or
equal to it. The lower bound is always in `[0,length]`, so the underlying
interval split cannot fail in a checked implementation. The source wrapper
retains `Slice.split`'s conservative failure branch so authority conservation
remains explicit.

`join` consumes the exact witness and exact siblings minted by the split.
Reassociation delegates to the same witness operations as `Slice`. `freeze` is
defined only for a complete root, as it delegates to `Slice.freeze`.

## 4. Why keys are immutable

Replacing a key can invalidate:

- strict ordering;
- uniqueness;
- the lower-bound result used to split;
- the logical key range named by a live sibling; and
- frame locality for operations on that sibling.

Therefore the adapter exposes only value replacement. Insertion and removal
change the footprint and need a different operation:

```text
resize : full-root authority -> full-root authority
```

or a stronger tree/page allocator proof capable of moving boundaries while
updating every affected witness. Neither is part of this adapter.

## 5. Refinement proof

Let `I(S, lo, hi)` be the existing array-interval authority and let `ordered(S)`
be the abstraction invariant established by `copy`. Define:

```text
MapRange(S, lo, hi) = I(S, lo, hi) + ordered(S)
```

The compiler proves only `I`; it does not add `ordered(S)` to its trusted fact
domain. The invariant is preserved by the operations exported from
`OrderedTextMap`, which expose no key mutation. Because Blot's public types are
structural, a caller can deliberately bypass the constructor by passing a
matching `Slice`; doing so violates the API precondition but cannot enlarge the
underlying interval authority or create memory unsafety.

### Acquisition

```text
strictly_ordered(entries)
--------------------------------
copy(entries) : MapRange(S,0,n)
```

When the premise is false, `copy` traps and produces no result.

The underlying `Slice.copy` retains its copy-safe semantics and may reuse the
Store only with its existing provenance proof.

### Borrowed lookup

Binary search inspects only entries in `[lo,hi)`. It changes neither Store nor
authority:

```text
MapRange(S,lo,hi) |- get(key) : Option V
```

### Value replacement

For the copyable value domain admitted by this adapter, if binary search focuses
position `i`, replacement writes `(key_i,replacement)`; it never writes the
requested key spelling:

```text
MapRange(S,lo,hi) * replacement
-----------------------------------------------
old * MapRange(S[value_i := replacement],lo,hi)
```

Using the stored key rather than the query key is necessary even when comparison
says they are equal; the current adapter uses exact text comparison, but this
choice keeps the preservation argument explicit.

### Partition

Let `mid = lower_bound(S, lo, hi, key)`. Existing interval partition proves:

```text
[lo,hi) = [lo,mid) * [mid,hi)
```

Strict ordering refines that equation into an exact disjoint key-range cover.
The generic witness remains sufficient; no second runtime witness is created.

### Join and freeze

Join and full-root freeze are the existing array-interval rules. The adapter
does not mint, inspect, or approximate witnesses in source.

## 6. Family status

At the public API layer, this is a second collection abstraction: users program
against ordered map operations, and positional mutation is not exposed.

At the compiler proof layer, it remains the `array-interval` family with a
checked source-level abstraction invariant. It does not claim to be the future
`map-key-set` family described by `PARTITIONED_CAPABILITIES.md`.

A true key-set family would allow arbitrary disjoint key subsets independent of
physical order. It would require family-tagged serialized ownership values and a
runtime representation for non-contiguous membership. This adapter chooses
ordered ranges because they reuse the current Store representation without
copying or adding runtime capability objects.

## 7. Cost model

For `n` entries:

| Operation       |                                                     Work | Element Store copies after acquisition |
| --------------- | -------------------------------------------------------: | -------------------------------------: |
| invariant check |                                  `O(n)` text comparisons |                                      0 |
| copy            | `O(n)` explicit acquisition; `O(1)` when reuse is proved |                   at most 1 full Store |
| length          |                                                   `O(1)` |                                      0 |
| get             |                                   `O(log n)` comparisons |                                      0 |
| replace         |              `O(log n)` comparisons + `O(1)` owned write |                                      0 |
| split_before    |                 `O(log n)` comparisons + `O(1)` metadata |                                      0 |
| join            |                                          `O(1)` metadata |                                      0 |
| freeze          |                      `O(1)` Store release in Runtime HIR |                                      0 |

The existing persistent `Map.with equal` is an association array. Its lookup is
`O(n)`; `put` rebuilds an `O(n)` array. The benchmark must compare equal
semantics over already ordered unique text keys, validate observations first,
and separately report acquisition so an `O(n)` one-time cost is not hidden.

Wasm byte size, compile time, Store operation classification, and warm execution
time are reported under `COST_MODEL.md`. Wall-clock speedup is evidence, not a
language guarantee. The semantic performance contract is that successful owned
replacement lowers to `store.write` with `owned-reuse` and performs no
persistent element-Store write.

## 8. Production gates

The adapter is production-complete only when Node and Rust/Wasm agree on:

1. validation, successful acquisition, and trapping invalid acquisition;
2. empty, singleton, boundary, present, and absent lower bounds;
3. borrowed lookup and rejection of acquisition with owned values;
4. success and failure replacement conservation;
5. split/join/reassociation witness exactness;
6. partial-freeze and stale/foreign-witness rejection inherited from `Slice`;
7. example observations;
8. proof erasure and ABI behavior;
9. deterministic generated prelude output; and
10. the benchmark's Store-write classification.

Because the adapter is ordinary prelude source, no syntax, parser, type-lattice,
Runtime-HIR, ABI, or primitive-registry change is permitted merely to make its
implementation convenient.
