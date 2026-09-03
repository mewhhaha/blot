# Executable example catalog

The catalog distinguishes four outcomes. Keeping them separate matters: a hard
but valid program, a specified trap, an invalid program, and a useful feature
that has not been implemented are four different claims about the language.

| location             | meaning                                                           | enforced outcome                                                                            |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `examples/*.blot`    | supported programs, including files prefixed `pathological_`      | check, evaluate to the golden value, and compile in the ordinary corpus                     |
| `examples/traps/`    | valid programs whose requested execution reaches a specified trap | check successfully, then fail during evaluation with the recorded code                      |
| `examples/rejected/` | programs the language intentionally rejects                       | fail in the recorded compiler phase with the recorded diagnostic                            |
| `examples/pending/`  | desirable pressure tests which are **not implemented yet**        | retain the recorded refusal or non-principal type, then fail loudly when it can be promoted |

## Everyday programs

These examples are good starting points when evaluating Blot as a programming
language rather than studying one compiler feature at a time.

| example                                                  | task and language features                                                  |
| -------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`bank_ledger.blot`](bank_ledger.blot)                   | execute deposits and withdrawals with a loop-carried immutable balance      |
| [`checkout_workflow.blot`](checkout_workflow.blot)       | separate checkout policy from inventory and payment through handled effects |
| [`configuration_layers.blot`](configuration_layers.blot) | apply typed configuration overrides with tagged commands                    |
| [`http_router.blot`](http_router.blot)                   | route method/path pairs with exhaustive matching and text predicates        |
| [`inventory_restock.blot`](inventory_restock.blot)       | derive a purchase order with typed records and a map/filter pipeline        |
| [`invoice_report.blot`](invoice_report.blot)             | calculate line totals, tax, and invoice aggregates in integer minor units   |
| [`log_report.blot`](log_report.blot)                     | split, clean, redact, filter, and summarize application logs                |
| [`shader_metadata.blot`](shader_metadata.blot)           | read WGSL at compile time and project filename plus struct metadata         |
| [`retry_policy.blot`](retry_policy.blot)                 | carry retry state through a bounded loop and stop on the first final result |
| [`shopping_cart.blot`](shopping_cart.blot)               | calculate checkout totals from immutable tuples and collection operations   |
| [`validation_pipeline.blot`](validation_pipeline.blot)   | accumulate accepted values and typed rejection reasons                      |
| [`word_frequency.blot`](word_frequency.blot)             | tokenize text, count sorted runs, and build an ordered text map             |

Run `deno task verify:showcase` to evaluate these programs against their golden
results and compile each one through the semantic compiler.

## Common algorithms

The graph examples keep adjacency arrays separate from the algorithms. Shared
modules under [`lib/`](lib/) provide vertex marks, distance storage, a logical
stack, and an integer min-priority queue without hiding the traversal itself.

| example                                                        | algorithm and Blot features                                                    |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`breadth_first_search.blot`](breadth_first_search.blot)       | `O(V + E)` FIFO traversal with hop distances and one discovery mark per vertex |
| [`depth_first_search.blot`](depth_first_search.blot)           | `O(V + E)` traversal using a reusable logical stack and vertex marks           |
| [`dijkstra_shortest_paths.blot`](dijkstra_shortest_paths.blot) | `O((V + E) log E)` relaxation using a binary min-heap and distance table       |
| [`topological_sort.blot`](topological_sort.blot)               | `O(V + E)` Kahn ordering with indegrees, a FIFO, and explicit cycle detection  |
| [`owned_quicksort.blot`](owned_quicksort.blot)                 | consuming quicksort with reusable array storage                                |
| [`owned_merge_sort.blot`](owned_merge_sort.blot)               | stable merge sort over owned arrays                                            |
| [`arena_binary_tree.blot`](arena_binary_tree.blot)             | compact tree construction and recursive traversal                              |
| [`walker.blot`](walker.blot)                                   | mutually recursive descent over a flattened expression tree                    |

Run `deno task verify:algorithms` for the four graph algorithms. The ordinary
catalog and corpus checks continue to cover the established algorithms.

Every pathological and pending file explains the edge in its opening comment.
Pending files are not language proposals by themselves; `LANGUAGE.md` and
`spec/` remain authoritative. They are executable markers for work already named
in `SUGGESTION.md` or a focused specification, not disabled tests that can
silently rot.

Here, "pathological" is a compiler term, not a judgment about the source. It
includes direct definitions commonly used to demonstrate functional
languages—naïve Fibonacci, recursive algebraic data, recursive descent, and
folds. Blot should make those definitions viable instead of requiring a second,
compiler-shaped program. Persistent quicksort remains executable as the
functional baseline in `experiments/owned-regions`; the catalog now uses the
equally direct consuming version. A pathological example first locks down
semantics and compilation; any performance claim needs a matching benchmark and
must preserve that same source definition.

When a pending case is implemented, move it to the top-level catalog, add its
golden value, and remove its entry from `PENDING` in `examples.test.ts`. When a
trap becomes total by design, promote it the same way rather than weakening the
expected diagnostic.
