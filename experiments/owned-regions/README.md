# Owned-region experiment

This directory is the executable half of
[`spec/OWNED_REGIONS.md`](../../spec/OWNED_REGIONS.md). It is intentionally a
draft before the production compiler learns the proposed `@region.*` operations.

The experiment checks three independent facts:

1. `claim` is rooted in a fresh Store allocation in `model.ts`; that allocation
   is the evidence that no older persistent alias can observe destructive writes.
2. `model.ts` checks after every successful operation that all live write regions
   for one Store are pairwise disjoint.
3. `src/linear/region_certificate.ts` replays a generic linear authority graph
   without looking at interval geometry. The model records that graph and
   verifies it again when the Store is frozen.

`quicksort.ts` uses those operations to sort one backing Store. Split and join
allocate permission metadata but perform zero element copies.

## Why the certificate is generic

The first theory draft described certificate events as `split`, `write`, `join`,
and `freeze`. Implementing the model showed that those names mix separate proof
obligations.

- **Store provenance:** destructive access starts only from an allocation known
  not to have a persistent observer.
- **Authority linearity:** an authority cannot be duplicated, reused after
  partition, or leaked.
- **Region semantics:** a particular partition is a disjoint cover and a
  particular combine is valid for that region family.

The compiler-side authority module therefore uses only these graph operations:

```text
claim(root, origin, family) -> p
partition(p)                -> [p1, ..., pn]
combine([p1, ..., pn])      -> p
transform(p)                -> p'
release(p)
```

The graph verifier receives a set of externally authorized `root` identities. It
checks that each root and acquisition generation is claimed once and that all
successor permits remain on that root/origin/family. It deliberately does not try
to derive Store uniqueness itself.

The array-interval validator separately proves that `@region.split` produces
`[lo,mid)` and `[mid,hi)`, that `@region.join` receives adjacent regions of one
Store, and that relative reads/writes remain within bounds.

This separation is the compositional part of the proposal. A future matrix-tile
or record-field region family can reuse the same authority graph and provide a
different semantic validator.

## Feedback that changed the theory

### `!` is not enough to claim a Store

This was the most important implementation finding. Linearity says how often a
binding may be consumed; it does not by itself prove that the Store reachable
through that binding has no persistent alias.

Conceptually, this is unsafe if `claim` trusts only the `!` marker:

```blot
let shared = [1, 2, 3]
let !candidate = shared
// `shared` may still observe the same Store.
let slice = @region.array.claim candidate
```

A production claim therefore needs a stronger external **Store-root proof**:
either the Store is freshly allocated into unique ownership, or uniqueness has
been preserved through operations already certified for destructive reuse. The
region certificate names that proof by `root`; it does not manufacture it from a
linear binding.

This gives the complete proof stack:

```text
Store-root proof
    -> one region claim
        -> linear authority graph
            -> family-specific region geometry
                -> destructive Runtime-HIR operation
```

### Failure must conserve authority

A total split cannot return an error with no owner. Its failure arm returns the
original region. Failed join returns both inputs. Failed write returns its input.
The model deliberately records no authority event on failure, making this rule
observable in tests.

### Empty regions still matter

Endpoint splits create empty permissions. They authorize no address, but they
remain linear obligations. The model initially requires `freeze` to hold the
only live permit for an origin, so a forgotten empty sibling is rejected rather
than silently becoming a leaked proof token.

### Adjacency is enough for combine

Join does not need a parent-tree identity. If two live regions from the same
origin are adjacent, their union is disjoint from every other live region: any
third region overlapping the union would have overlapped one of the inputs.
This allows reassociating nested partitions without copying or rebuilding an
exact split tree.

### The source representation should stay private

A raw `(Store,start,length)` record would let source code project the whole Store
and bypass slice-relative mutation. The production representation should
therefore be compiler-private, or destructive operations must require a region
certificate that survives projection and still restricts the writable range.
The first implementation should choose the private representation because it has
the smaller proof surface.

## Production wiring proposed next

The intended compiler implementation is deliberately staged.

### A. Store provenance

Extend the existing destructive-reuse evidence so it can name a Store allocation
root, not just a consuming source occurrence. Fresh Store construction should be
the simplest root. A reusable destructive update can preserve that root into its
result. Persistent copies/aliases must not.

`@region.array.claim` is accepted only when its source carries such a root. The
claim consumes that root generation into region authority, so the ordinary whole
Store cannot simultaneously remain destructively usable.

### B. Checker/certificate

Add region authority to the ownership result beside current structural lineage.
A successful claim emits one root-backed permit. `@region.split`,
`@region.join`, `@region.array.set`, `@region.array.swap`, and
`@region.array.freeze` emit the generic events in
`src/linear/region_certificate.ts`.

The existing ownership checker remains responsible for source control-flow
agreement. The region certificate is a second replayable proof, not a new type
lattice.

### C. Runtime HIR

Introduce a private `slice` representation carrying a Store plus start/length
(or start/end) metadata. It must not be admitted by ABI 1.

Suggested operations:

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

Only `slice.write` and `slice.swap` are destructive. The validator requires a
matching verified authority event and checks interval bounds before emission.
Split/join are metadata-only.

### D. Type representation

Do not expose lifetime or region variables. A slice needs only enough settled
source typing for its element representation. The first implementation can use
one compiler-private parametric representation created by the intrinsics and
refuse it at module ABI boundaries.

If making a parametric private source value causes disproportionate inference
complexity, an alternative is a private nominal generated per specialized `[A]`
Store representation. That is a lowering representation decision, not a new
source type rule.

### E. Prelude

Once the trusted operations compile, expose ordinary wrappers as `Slice` so
application code does not depend on `@region.*` spellings.

### F. Gate

Before changing `LANGUAGE.md`, require all of:

- Store-root/provenance tamper tests;
- region-authority certificate tamper tests;
- split/join failure-conservation tests;
- evaluator vs emitted-Wasm agreement;
- a quicksort corpus entry showing one element Store allocation;
- a negative test showing claim from a merely linear alias is refused;
- a negative test showing use of a parent after split is refused;
- a negative test showing two different roots/origins cannot join; and
- a negative test showing a partial region cannot freeze.

The draft PR intentionally stops before claiming those production gates are
satisfied. The executable model is the specification probe for the next compiler
patch, not evidence that `@region.*` is already a supported Blot API.
