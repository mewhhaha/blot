# Reusable Array scratch storage

## 1. Boundary

`Scratch.of T` is an opaque affine capability for constructing one `[T]` without
first inventing `T` values for its unused capacity. It is not a second Array and
it does not expose uninitialized memory. Write

```text
Scratch(S, n, c, E)
```

for the unique capability over allocation `S`, where `n <= c`, exactly the
prefix `[0,n)` is initialized, and `E` records the ownership obligations of that
prefix. Capacity and the uninitialized suffix are unobservable.

Scratch is affine rather than linear: abandoning an empty builder is safe.
Pushing a value transfers its obligation into `E`, so a builder containing an
exact linear value still cannot be abandoned by the ordinary aggregate rules.
Scratch cannot be shared, frozen, stored in an Array, or cross an ABI boundary.

## 2. Operations

The public prelude wrappers are ordinary names over five primitives:

```text
@scratch.type T                   : Type
@scratch.with_capacity n          : Scratch T
@scratch.push (scratch, value)    : Scratch T
@scratch.finish scratch           : [T]
@scratch.recycle values           : Scratch T
```

`with_capacity` accepts `n : Int` and rejects a negative or non-machine-sized
capacity. It creates a logically empty builder with room for at least `n`
elements. `push` initializes the next position and may grow geometrically.
`finish` consumes the builder and returns its initialized prefix as an owned
Array without copying. `recycle` consumes an owned Array, discards its droppable
elements, and returns the same allocation as an empty builder whose capacity is
at least the old length. Recycling is rejected when discarding the element tree
would lose an exact linear obligation.

Their persistent meanings are respectively empty construction, append,
materialization of the appended sequence, and empty construction after consuming
the old sequence. Allocation reuse is target permission derived from the affine
root; it never changes those meanings.

## 3. Runtime representation

Runtime HIR represents Scratch privately as `(pointer, length, capacity)` plus
its closed element layout. Only `[0,length)` may be read or exposed. `push`
writes at `length`, increments it, and grows only when `length = capacity`.
`finish` projects `(pointer,length)` to Store. `recycle` maps Store
`(pointer,length)` to Scratch `(pointer,0,length)`.

Runtime-HIR schema 4 validates the type and four runtime operations. Scratch is
never encoded by Blot Core Wasm ABI 1. Checked-module certificate schema 10
records Scratch roots and their structural result lineage; linearity remains
outside the type lattice.

## 4. Sorting use

Bottom-up merge sort alternates one full Array and one empty Scratch. A pass
borrows the Array, pushes the merged order into Scratch, finishes the target,
then recycles the old source. Therefore it performs one `O(n)` allocation,
`O(n log n)` initialized writes, and no persistent element-Store update.

Stable indexed radix scatter does not fit the sequential Scratch protocol. Its
production implementation uses explicit initialized destination copies and owned
indexed writes. The unstable American-flag path instead permutes cached
`(value,key)` entries together in one Store. No indexed-uninitialized primitive
is added merely to reduce the stable variant's initialization pass.

## 5. Safety and cost obligations

1. At most one live capability names a Scratch allocation.
2. A position is exposed only after exactly one initialization.
3. `finish` returns every initialized element obligation exactly once.
4. `recycle` never discards an exact linear obligation.
5. Scratch never reaches a public ABI layout.
6. Evaluator and emitted Wasm agree on the finished Array.
7. Merge sorting allocates one scratch element buffer and emits no persistent
   Store write after acquisition.
