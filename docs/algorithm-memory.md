# Algorithm memory guide

Fresh arrays are owned until shared. A consuming transformation can therefore
reuse their Store without a copy, while a frozen or aliased array needs an
explicit `Array.copy` before update. `Slice` is the stronger linear form: it can
split one Store into disjoint Regions and carries witnesses that reconstruct the
root.

Prefer an ordinary consuming Array function when one authority moves through the
algorithm sequentially. Prefer `Slice` when disjoint intervals must be live at
the same time or passed to independent callees. Keep a result persistent when it
grows, shrinks, changes element type, or must coexist with the input.

## Current examples

| source                                                                                        | current cost boundary                                                                                                                                    | decision                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`examples/owned_quicksort.blot`](../examples/owned_quicksort.blot)                           | Average `O(n log n)` and worst `O(n^2)` comparisons; `O(1)` auxiliary elements; `O(log n)` recovered stack; no copy when its fresh Array is handed over  | Canonical compact quicksort. The prelude owns one Array authority and threads it through smaller-first recursion.                        |
| [`examples/higher_order_owned_fold.blot`](../examples/higher_order_owned_fold.blot)           | `O(n)` callback calls; the accumulator Store remains reusable across the opaque callback boundary                                                        | Canonical direct-result relation. `?next <- step (?current, value)` states the complete one-step authority transfer.                     |
| [`examples/higher_order_owned_quicksort.blot`](../examples/higher_order_owned_quicksort.blot) | The same update and stack bounds as the direct version; its imported driver adds no ownership-specific runtime representation                            | Canonical higher-order witness. The driver's constructor arms state the finite callback ownership relation.                              |
| [`examples/region_zipper_quicksort.blot`](../examples/region_zipper_quicksort.blot)           | One `Slice.copy` acquisition, in-place partition writes, `O(1)` auxiliary elements, and up to `O(n)` reconstruction frames on maximally unbalanced input | Use when disjoint Regions and explicit recombination are the point. It is more general than the sequential version, but not the default. |
| [`examples/slice_partition.blot`](../examples/slice_partition.blot)                           | `O(n)` predicate calls and swaps, `O(1)` auxiliary element storage, and no element-Store allocation after acquisition                                    | Already has the preferred consuming form.                                                                                                |
| [`examples/owned_ordered_text_map.blot`](../examples/owned_ordered_text_map.blot)             | `O(log n)` lookup; replacement reuses the entries Store; split and join move authority without copying elements                                          | Already has the preferred consuming form for fixed-size updates.                                                                         |
| `collections.blot`, `polymorphic_collections.blot`, `sets.blot`, and `shopping_cart.blot`     | `map`, `filter`, set insertion/removal, and aggregation construct differently shaped results                                                             | Keep persistent. A fixed-length ownership contract would be false for these operations.                                                  |
| `arena_binary_tree.blot`, `arena_list.blot`, and `arena_doubly_linked_list.blot`              | Arena construction appends nodes; repeated shared growth can copy earlier nodes                                                                          | Keep direct until Blot has an owned growable arena. A fixed-size `Slice` cannot express insertion honestly. Traversal stays read-only.   |
| `indexed.blot`, `walker.blot`, and traversal portions of the arena examples                   | Borrowed reads with no output permutation                                                                                                                | Keep read-only. Copying into a private Store would add an acquisition boundary without enabling useful reuse.                            |
| `pathological_fibonacci.blot`                                                                 | Exponential calls by design                                                                                                                              | Keep pathological. It is an optimization target, not an example of collection ownership.                                                 |

Prelude `Array.map`, `Array.filter`, `Array.partition`, set operations, and
`sort_by` also build persistent results. The first four can change result shape
or element type. `sort_by` is a stable compile-time insertion sort used for
small declaration layouts; replacing it deserves a separate equal-semantics
benchmark rather than silently making the prelude linear.

The Haskell-shaped `uncons`/stable-`partition`/append recurrence is not a
special persistent escape hatch. Once an Array has been shared, Blot refuses to
upgrade it to unique authority or insert a hidden copy for a consuming recursive
call. Source that deliberately retains an alias must name `Array.copy`.

## Review rule

For a new flat-array algorithm, ask these questions in order:

1. Does the result have the same element type and length as the input?
2. Does the caller surrender the old ordering rather than retaining an alias?
3. Can every failure path return the same authority unchanged?
4. Can the algorithm thread one Array authority sequentially, with borrows
   confined to the current call?

If all four answers are yes, prefer the consuming formulation and verify its
Runtime HIR contains owned-reuse writes with no persistent element writes after
acquisition. Use `Slice` only when the proof needs independently live regions.
Otherwise keep the persistent formulation and state its allocation boundary. For
owned element types, use operations such as `Slice.replace` whose success and
failure variants conserve every linear obligation; the current copying partition
helpers are intentionally limited to copyable elements.
