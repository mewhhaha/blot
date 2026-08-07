# Owned-region experiment

This directory is the executable half of
[`spec/OWNED_REGIONS.md`](../../spec/OWNED_REGIONS.md). It is intentionally a
draft before the production compiler learns the proposed `@region.*` operations.

The experiment separates three proof obligations which looked similar in the
first sketch but are not interchangeable:

1. **Store provenance** says whether a backing allocation has an older persistent
   observer and may therefore be stolen for destructive reuse.
2. **Path-sensitive ownership** says whether the value carrying an authority is
   consumed exactly once along each execution path. Production Blot already has
   this analysis; the experiment does not replace it.
3. **Region derivation** says which part of the private resource the authority
   may touch and how trusted partitions/combinations transform that permission.

`quicksort.ts` sorts one backing Store after acquisition. Split and join allocate
permission metadata but perform zero element copies.

## Two acquisition paths, one source meaning

A plain `claim(values)` models the safe source semantics. It copies a potentially
shared input into one fresh private Store, then gives the slice full authority
over that Store.

`freshOwned(values)` plus `claimOwned(owned)` is a model-only probe of the
compiler optimization: when a separate Store-provenance proof establishes that
an allocation is already unique, claim may steal that exact Store and skip the
acquisition copy.

```text
shared/unknown input -> copy -> fresh Store root -> region authority
proved unique input ---------> existing Store root -> region authority
```

The tests distinguish `acquisitionCopies` from `elementCopies`. Quicksort should
perform no element copies after acquisition on either path.

This distinction came from an important counterexample. A linear binding alone
is not a Store-uniqueness proof:

```blot
let shared = [1, 2, 3]
let !candidate = shared
```

`candidate` must be consumed according to its qualifier, but `shared` may still
observe the same persistent Store. Zero-copy claim therefore needs stronger
allocation provenance than `!`.

## The trace verifier is not the source ownership checker

`src/linear/region_certificate.ts` replays a **single concrete authority trace**:

```text
claim(root, origin, family) -> p
partition(p)                -> [p1, ..., pn]
combine([p1, ..., pn])      -> p
transform(p)                -> p'
release(p)
```

It is useful for the executable runtime model and hostile-input tests. It rejects
untrusted or multiply claimed roots, duplicate permits, use-after-partition,
incompatible joins, double releases, and leaked leaves.

It must not become Blot's only static ownership certificate. Source branches are
alternatives, not sequential events:

```text
if condition:
  transform p at A
else:
  transform p at B
```

A flattened trace containing both A and B would falsely report a double consume.
The existing ownership checker already has the required branch snapshots and
agreement rule, and its certificate can name multiple consumption sites while
proving that each execution path consumes the binding once.

Production region support should therefore attach region lineage to the existing
`Produced` ownership leaves. The current trace verifier remains an executable
oracle for the local authority algebra, not a second control-flow analysis.

## Region families are separate from ownership flow

`src/linear/region_interval.ts` implements the first region family: half-open
array intervals. It knows validity, disjointness, exact split cover, adjacency,
relative indexing, and full-extent coverage.

The ownership checker should not hard-code intervals. A trusted operation names a
region family, and the family supplies the local laws needed to validate its
partition/combine/access witnesses. A future matrix tile, byte-buffer segment,
or arena range can reuse the same path-sensitive ownership integration with a
different region validator.

The intended proof stack is:

```text
Store provenance
    -> existing path-sensitive ownership
        -> family-specific region derivation
            -> destructive Runtime-HIR operation
```

## Feedback that changed the design

### Failure must conserve authority

A total operation cannot lose its owner on an error path. Failed split returns
the original region; failed join returns both inputs; failed set/swap return the
input. The model records no authority transition when an operation fails.

### Empty regions still matter

Endpoint splits create empty permissions. They authorize no address, but remain
linear obligations. The model requires `freeze` to hold the only live permit for
an origin, so a forgotten empty sibling is rejected instead of silently leaking
a proof token.

### Adjacency is enough for interval join

A join does not need an exact split-tree identity. If two live intervals from one
origin are adjacent, their union is still disjoint from every other live interval:
anything overlapping the union would have overlapped one input. This permits
reassociation of nested partitions.

### Owned elements need a consuming acquisition

The copy-safe `claim(values)` model is sound for arrays whose element values carry
no linear or affine obligations. Copying an element that owns a resource would
duplicate its obligation.

A later owned-element version should move obligations into the private Store and
reuse Blot's existing consuming-array extraction lineage. The first production
slice API should either restrict claim/set to unrestricted elements or implement
that transfer explicitly; it must not infer copyability from the array shape.

### The slice representation should stay private

A raw source record `(Store,start,length)` would expose the whole Store and let
code bypass slice-relative mutation. Runtime HIR may use such a representation,
but source code should see an opaque/private slice value and ABI 1 should refuse
it while authority is live.

## Production wiring proposed next

### A. Store provenance and acquisition

Extend destructive-reuse evidence with an allocation-root identity. Fresh private
Store construction creates a root. A proven owned update may preserve it;
persistent aliases/copies do not.

`@region.array.claim` then has two lowering paths with identical source behavior:

- **fresh:** allocate/copy and create a new root;
- **reuse:** consume a valid Store root and retain its allocation.

### B. Existing ownership lineage

Do not emit a flat static authority event stream. Add region derivation to the
existing path-sensitive ownership facts. Conceptually a carried ownership leaf
can record local steps such as:

```text
claim(root, family, operation)
partition(parent, part, part_count, operation)
combine(parents, operation)
transform(parent, operation)
```

The current branch/loop/closure analysis decides whether each resulting leaf is
consumed correctly. Region verification decides whether the local derivation is
valid for the named family.

### C. Runtime HIR

Introduce a private slice representation and operations roughly equivalent to:

```text
slice.claim      store -> slice
slice.length     slice -> i64
slice.split      slice, i64 -> split-result
slice.join       slice, slice -> join-result
slice.read       slice, i64 -> element
slice.write      slice, i64, element -> slice
slice.swap       slice, i64, i64 -> slice
slice.freeze     slice -> store
```

`split` and `join` are metadata-only. `write` and `swap` are destructive and
require both the ownership occurrence and region witness to validate.

### D. Prelude

Once the trusted operations compile, expose ordinary `Slice` wrappers so normal
application code does not depend on `@region.*` spellings.

## Gate before calling it language

Before changing `LANGUAGE.md`, require at least:

- Store-provenance tests proving a persistent observer blocks zero-copy claim;
- shared-input acquisition proving the copy-safe path remains valid;
- first-version restriction or consuming transfer for owned elements;
- branch tests where alternative paths transform/return one slice;
- region-lineage tamper tests proving all partition outputs are accounted for;
- exact split/join/bounds/empty/full interval tests;
- failure-conservation tests for every total operation;
- evaluator / Runtime HIR / emitted-Wasm agreement;
- ABI refusal for a live slice;
- an in-place quicksort corpus entry with no element-Store allocations after
  acquisition; and
- a benchmark separating acquisition-copy cost from partition/sort cost.

The draft deliberately stops short of claiming `@region.*` is implemented Blot
syntax. The purpose of the executable model is to settle the proof boundary
before those compiler operations become trusted.
