# Algorithm memory guide

Fresh arrays are owned until shared. A consuming transformation can therefore
reuse their Store without a copy, while a frozen or aliased array needs an
explicit `Array.copy` before update. `Slice` is the stronger linear form: it can
split one Store into disjoint Regions and carries witnesses that reconstruct the
root.

Prefer an ordinary consuming Array function when one authority moves through the
algorithm sequentially. Prefer `Slice` when disjoint intervals must be live at
the same time or passed to independent callees. When a result changes shape or
element type, build a fresh owned output and thread that authority through the
traversal instead of retaining every intermediate prefix.

## Current examples

| source                                                                                        | current cost boundary                                                                                                                                    | decision                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [`examples/owned_quicksort.blot`](../examples/owned_quicksort.blot)                           | Average `O(n log n)` and worst `O(n^2)` comparisons; `O(1)` auxiliary elements; `O(log n)` recovered stack; no copy when its fresh Array is handed over  | Canonical compact quicksort. The prelude owns one Array authority and threads it through smaller-first recursion.                        |
| [`examples/higher_order_owned_fold.blot`](../examples/higher_order_owned_fold.blot)           | `O(n)` callback calls; the accumulator Store remains reusable across the opaque callback boundary                                                        | Canonical direct-result relation. `use ?next <- step (?current, value)` states the complete one-step authority transfer.                 |
| [`examples/higher_order_owned_quicksort.blot`](../examples/higher_order_owned_quicksort.blot) | The same update and stack bounds as the direct version; its imported driver adds no ownership-specific runtime representation                            | Canonical higher-order witness. The driver's constructor arms state the finite callback ownership relation.                              |
| [`examples/region_zipper_quicksort.blot`](../examples/region_zipper_quicksort.blot)           | One `Slice.copy` acquisition, in-place partition writes, `O(1)` auxiliary elements, and up to `O(n)` reconstruction frames on maximally unbalanced input | Use when disjoint Regions and explicit recombination are the point. It is more general than the sequential version, but not the default. |
| [`examples/slice_partition.blot`](../examples/slice_partition.blot)                           | `O(n)` predicate calls and swaps, `O(1)` auxiliary element storage, and no element-Store allocation after acquisition                                    | Already has the preferred consuming form.                                                                                                |
| [`examples/owned_ordered_text_map.blot`](../examples/owned_ordered_text_map.blot)             | `O(log n)` lookup; replacement reuses the entries Store; split and join move authority without copying elements                                          | Already has the preferred consuming form for fixed-size updates.                                                                         |
| Prelude `Array.map`, `Array.filter`, and `Array.partition`                                    | `O(n)` ordered traversal and total `O(n)` result elements; each fresh output threads one owned Store                                                     | The input remains borrowed while differently shaped or typed outputs are built without persistent prefixes.                              |
| [`examples/word_frequency.blot`](../examples/word_frequency.blot)                             | `O(n log n)` token comparisons for stable merge sort, `O(n)` run collection, and `O(log u)` lookup for `u` distinct words                                | Sorting makes the frequency pass linear and produces entries already ordered for `OrderedTextMap`.                                       |
| Breadth-first, depth-first, and topological graph examples                                    | `O(V + E)` work; FIFO and logical-stack backing Stores grow to their maximum live size and retain that capacity                                          | Integer tables and cursors keep updates consuming; no pop compacts an Array.                                                             |
| [`examples/dijkstra_shortest_paths.blot`](../examples/dijkstra_shortest_paths.blot)           | `O((V + E) log E)` for nonnegative weights; `O(V)` tables and up to `O(E)` lazy heap entries                                                             | The binary heap retains its backing Store and changes a logical length, avoiding a linear Array rebuild on every pop.                    |
| `arena_binary_tree.blot`, `arena_list.blot`, and `arena_doubly_linked_list.blot`              | Arena construction appends nodes; repeated shared growth can copy earlier nodes                                                                          | Keep direct until Blot has an owned growable arena. A fixed-size `Slice` cannot express insertion honestly. Traversal stays read-only.   |
| `indexed.blot`, `walker.blot`, and traversal portions of the arena examples                   | Borrowed reads with no output permutation                                                                                                                | Keep read-only. Copying into a private Store would add an acquisition boundary without enabling useful reuse.                            |
| `pathological_fibonacci.blot`                                                                 | Exponential calls by design                                                                                                                              | Keep pathological. It is an optimization target, not an example of collection ownership.                                                 |

Set operations remain persistent because their existing values can stay shared.
`sort_by` is a stable compile-time insertion sort used for small declaration
layouts; replacing it deserves a separate equal-semantics benchmark rather than
silently changing that boundary.

The Haskell-shaped `uncons`/append recurrence is not a special persistent escape
hatch. Repeatedly removing an element or appending to a shared prefix copies the
remaining prefix and can turn a linear-looking traversal quadratic. A worklist
that removes entries should retain a backing Store with a logical cursor or
length. Once an Array has been shared, Blot refuses to upgrade it to unique
authority or insert a hidden copy for a consuming recursive call. Source that
deliberately retains an alias must name `Array.copy`.

## Review rule

For a new flat-array algorithm, ask these questions in order:

1. Can the result reuse the input's element representation and ordering?
2. Does the caller surrender the input rather than retain an alias?
3. If the result has a different shape, can one or more fresh output authorities
   move through the traversal?
4. Can every branch return or transfer every authority exactly once?

When the first two answers are yes, prefer consuming input reuse. Otherwise,
prefer a fresh owned output when the third and fourth answers are yes. Keep an
operation persistent only when an earlier version must remain observable, and
state that allocation boundary. Verify consuming cycles contain owned-reuse
writes with no persistent element writes after acquisition. Use `Slice` only
when independently live regions are part of the proof. For owned element types,
use operations such as `Slice.replace` whose success and failure variants
conserve every linear obligation; copying partition helpers remain limited to
copyable elements.
