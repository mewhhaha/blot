# Algorithm memory guide

Blot has two honest algorithm styles. Ordinary arrays are persistent values:
updates preserve the old value and may copy a backing Store. `Slice` is a
private, linear view: `Slice.copy` explicitly enters that representation, and a
consuming `Slice -> Slice` transform may then reuse one Store. The compiler can
elide the written copy when it proves that Store is already unique.

Prefer `Slice` when an algorithm permutes or replaces elements without changing
the collection's length. Keep ordinary arrays when the result grows, shrinks,
changes element type, or must coexist with the input. The linear spelling is not
automatically better merely because it exists.

## Current examples

| source                                                                                                          | current cost boundary                                                                                                                                                                 | decision                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`examples/owned_quicksort.blot`](../examples/owned_quicksort.blot)                                             | Average `O(n log n)` and worst `O(n^2)` comparisons; `O(1)` auxiliary element storage; `O(log n)` call stack after tail-loop recovery; no element-Store allocation after `Slice.copy` | Canonical generic quicksort. It consumes one complete `Slice`, recurses into the smaller partition, and tail-recurses into the larger one.                                   |
| [`experiments/owned-regions/structural_quicksort.blot`](../experiments/owned-regions/structural_quicksort.blot) | Stable partition and persistent append make balanced levels approximately `O(n^2)` in copied elements and maximally unbalanced input `O(n^3)` with the current Store representation   | Retained as the clearest functional baseline, not the default performance example.                                                                                           |
| [`examples/slice_partition.blot`](../examples/slice_partition.blot)                                             | `O(n)` predicate calls and swaps, `O(1)` auxiliary element storage, and no element-Store allocation after acquisition                                                                 | Already has the preferred consuming form.                                                                                                                                    |
| [`examples/owned_ordered_text_map.blot`](../examples/owned_ordered_text_map.blot)                               | `O(log n)` lookup; replacement reuses the entries Store; split and join move authority without copying elements                                                                       | Already has the preferred consuming form for fixed-size updates.                                                                                                             |
| `collections.blot`, `polymorphic_collections.blot`, `sets.blot`, and `shopping_cart.blot`                       | `map`, `filter`, set insertion/removal, and aggregation construct differently shaped results                                                                                          | Keep persistent. A fixed-length `Slice -> Slice` contract would be false for these operations.                                                                               |
| `arena_binary_tree.blot`, `arena_list.blot`, and `arena_doubly_linked_list.blot`                                | Arena construction appends nodes; repeated persistent growth can copy earlier nodes under the current Store runtime                                                                   | Keep the examples direct until Blot has an owned growable arena. A fixed-size `Slice` cannot express insertion honestly. Traversal is read-only and does not need ownership. |
| `indexed.blot`, `walker.blot`, and traversal portions of the arena examples                                     | Borrowed reads with no output permutation                                                                                                                                             | Keep read-only. Copying into a private Store would add an acquisition boundary without enabling useful reuse.                                                                |
| `pathological_fibonacci.blot`                                                                                   | Exponential calls by design                                                                                                                                                           | Keep pathological. It is an optimization target, not an example of collection ownership.                                                                                     |

Prelude `Array.map`, `Array.filter`, `Array.partition`, set operations, and
`sort_by` also build persistent results. The first four can change result shape
or element type. `sort_by` is a stable compile-time insertion sort used for
small declaration layouts; replacing it deserves a separate equal-semantics
benchmark rather than silently making the prelude linear.

## Review rule

For a new flat-array algorithm, ask these questions in order:

1. Does the result have the same element type and length as the input?
2. Does the caller surrender the old ordering rather than retaining an alias?
3. Can every failure path return the same authority unchanged?
4. Can the algorithm be written as one explicit `Slice -> Slice` ownership
   transfer, with borrows confined to the current call?

If all four answers are yes, prefer the consuming formulation and verify its
Runtime HIR contains owned-reuse writes with no persistent element writes after
acquisition. Otherwise keep the persistent formulation and state its allocation
boundary. For owned element types, use operations such as `Slice.replace` whose
success and failure variants conserve every linear obligation; the current
copying partition helpers are intentionally limited to copyable elements.
