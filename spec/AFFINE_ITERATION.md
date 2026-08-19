# Affine array iteration

## 1. Surface contract

Blot does not need a second collection category called a view. Address order is
an iterator, and the recommended consumer remains the existing `for` form.

```blot
for value in Iter.slice (values, 2, 8):
  use value

for value in Iter.reverse values:
  use value

for value in Iter.affine (values, start, stop, stride):
  use value
```

`Iter.affine (values, start, stop, stride)` has one integer state. For a
positive stride it yields in-bounds elements while `index < stop`; for a
negative stride it yields them while `index > stop`. The stop is exclusive. A
zero stride is the empty iterator. An out-of-bounds state ends iteration, so the
operation is total for every integer input.

`Iter.slice (values, start, stop)` is affine iteration with stride `1`.
`Iter.reverse values` starts at `Array.length values - 1`, stops at `-1`, and
uses stride `-1`. All three functions are ordinary prelude code over the public
`.state` / `.step` iterator protocol. There is no syntax, AST node, type
constructor, Runtime-HIR operation, or ABI value for a view.

## 2. Evidence split

The traversal combines the existing three evidence layers without merging their
laws:

| Layer   | Traversal evidence                                                                               | Lifetime                                    |
| ------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `Gamma` | homogeneous `[A]` carrier and the settled Store element representation                           | through specialization and layout selection |
| `Phi`   | loop direction, exclusive stop, Store bounds, and the induction relation `next = index + stride` | erased after the checked read is lowered    |
| `Omega` | optional authority to consume or reuse an owned root                                             | retained only for destructive operations    |

Reading through an affine iterator needs no `Omega`: immutable Store identity
and duplicable bounds facts are enough. A later destructive traversal must add
ownership authority; a range proof must never be treated as permission to write.
Layout is likewise not a subtype. Runtime HIR chooses the element stride only
after `A` is closed.

## 3. Stable Store identity

A residual dynamic array literal is an immutable logical value. Reconstructing
it every time a closure captures it is correct but needlessly allocates and
copies. Runtime-HIR lowering therefore materializes such an array at its first
name binding and places the resulting Store value in the residual environment.
Every later length query, iterator capture, and read refers to that same SSA
Store identity.

Wholly static arrays remain residual values and can still be folded without a
Store. A newly materialized dynamic literal is marked fresh at the binding. A
linear binding may turn that freshness into existing reusable-Store authority;
an unrestricted binding immediately drops the authority while retaining the
immutable Store value. Aliasing an unrestricted value can never recreate
freshness.

This binding rule avoids a global materialization cache. Such a cache would be
unsound across control-flow branches because an SSA value created in one arm
does not dominate another. Materializing at the lexical binding gives the Store
an explicit dominance point and makes sharing visible to validation.

## 4. Lowering

`for` already desugars during CST lowering to tail recursion over `.state` and
`.step`. Prelude specialization exposes the affine iterator as:

```text
root   = one Store SSA value
state  = index
next   = index + stride
guard  = direction(index, stop, stride) and 0 <= index < length(root)
value  = store.read(root, index)
```

The root, stop, and stride are loop-invariant captures. Tail-loop recovery turns
the recursion into a Runtime-HIR back edge. The selected values are never
assembled into another Store, and ordinary work in the `for` body is fused into
the same loop. Mapping is written in the body; filtering is a refutable loop
pattern or an `if`; collecting is explicit through `Iter.collect` or
`@array.push`.

This is deliberately a one-dimensional affine address transform. Tiling, zipping
roots, permutation tables, and mutable partitions require different proofs and
should not be smuggled in as fields on an open-ended view record. They can add
new iterators when their bounds, alias, and ownership laws are complete.

## 5. Executable acceptance boundary

The Runtime-HIR regression constructs `[dynamic, 2, 3, 4, 5]`, consumes it
through slice, reverse, and stride `for` loops, and establishes all of the
following:

- exactly one `store.empty` and five `store.grow` operations construct the root,
  rather than one reconstruction per capture;
- the three loop bodies contain `store.read` and no temporary Store;
- no `call.direct` remains for the iterator helpers;
- emitted WebAssembly evaluates the combined program to `38`; and
- the source example covers positive, negative, and zero strides.

These are the complete guarantees of this feature. More aggressive bounds-check
elimination is an optimization only when the existing `Phi` certificate proves
the same guard; it does not change the iterator semantics.
