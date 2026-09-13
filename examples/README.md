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

## Effect and type abstractions

These examples build APIs from ordinary type values. Effect-oriented examples
interpret computations with ordinary handler records. Each runs with
`pnpm blot run examples/<name>.blot`.

[`record_view_results.blot`](record_view_results.blot) exercises a related
representation boundary: functions consume a `{ .count = Int; }` view of a wider
record and return fresh integer and text records with their own layouts.

| Example                                                      | Abstraction                                                                                                       | Observations                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [`nonempty_effect_stream.blot`](nonempty_effect_stream.blot) | A nonempty producer becomes a sum, text, or its first element through different handlers                          | `42`, `"10, 20, 12"`, and `10`; a singleton renders as `"7"` |
| [`typed_effect_pipeline.blot`](typed_effect_pipeline.blot)   | A map handler translates an integer effect into a text effect; the next handler joins it                          | `"$10 + $20 + $12"`                                          |
| [`schema_effects.blot`](schema_effects.blot)                 | A record of types generates reader operations; a handler factory checks supplied settings against the same schema | `"localhost:8080"` and `"example.com:443"`                   |
| [`linear_transaction.blot`](linear_transaction.blot)         | An effect produces a linear pending transaction; commit and rollback consume it and return receipts               | `#Committed "order-42"` and `#RolledBack "order-42"`         |
| [`typed_quantities.blot`](typed_quantities.blot)             | A compile-time descriptor couples a nominal quantity type to operations and generates typed unit conversions      | `1550 m`, `155000 cm`, and `90 s`                            |
| [`typed_lenses.blot`](typed_lenses.blot)                     | Composable lenses connect immutable nested updates through statically matched whole/part types                    | `"London"` -> `"London / west"`; postal becomes `90210`      |
| [`composable_ordering.blot`](composable_ordering.blot)       | Typed key projection, reversal, and lexicographic tie-breakers compose one reusable `Order Ticket`               | priority desc; team/id asc; equal keys stay stable           |
| [`typed_nonempty.blot`](typed_nonempty.blot)                 | A head-plus-tail collection is statically nonempty while satisfying structural collection interfaces              | first `"Ada"`, length `4`, total weight `11`, and typed route |

`typed_nonempty.blot` represents a nonempty collection directly as a required
`.head` plus an array `.tail`. The same implementation record satisfies concrete
`Semigroup`, `Mappable`, `Foldable`, and `Length` interfaces through structural
typing, while deliberately failing `Monoid` because no `.empty` value can exist.
Its focused test also locks down rejection of a headless value.

The nonempty stream's final `return` supplies its last element. Its result
signature requires that element even when the producer makes no `emit` calls,
which is the singleton case. Reduction starts with that final element and
combines earlier emissions while continuations unwind. Text separators therefore
appear only between elements, and the first-element handler returns a value
directly. This is a right reduction; the example makes no constant-stack claim.

The schema example derives the effect interface and implements its clauses in
`supply`. That factory explicitly checks the answers with `@satisfies`; it does
not rely on the current generic handler's resume-result inference to enforce the
port refinement. Its answers are supplied source values, not decoded user input.
The transaction handlers simulate the ownership protocol; they do not implement
database durability or isolation. The quantity example keeps its operation
dictionary explicit because attached type namespaces are intentionally outside
the structural type lattice; its `.type` member carries the nominal type into
generic checked signatures without runtime dispatch.

The lens example treats a path as a pair of ordinary functions plus the type
relationship between its whole and focused part. Composition reuses the same
middle type on both sides, so a non-adjacent path is rejected statically while
`Shape.update` preserves fields outside each local focus.

The ordering example treats an ordering policy as an ordinary structural record.
`on` uses two quantified types to connect a projection result to its key order,
`reverse` changes direction without changing the subject, and `then` composes
tie-breakers. The concrete `Order Ticket` signature closes the subject type
after composition; the stable merge sort preserves source order when every
configured key compares equal.

`src/node/effect_abstractions.test.ts` checks principal types, both executions,
the singleton and early-exit cases, and rejection of nonpositive emissions,
missing final elements, invalid ports, duplicate commits, and abandoned
transactions. Focused Node tests cover runtime results, formatting, type
boundaries, and rejected programs. `deno task verify:showcase` runs the catalog.

The [ECS case study](../case-studies/ecs/README.md) develops these ideas into
generated components, composable reader queries, and fused row schedules, with
an executable cost comparison.

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
| [`typed_transitions.blot`](typed_transitions.blot)       | compose tagged protocol states through a rank-polymorphic transition alias  |
| [`validation_pipeline.blot`](validation_pipeline.blot)   | accumulate accepted values and typed rejection reasons                      |
| [`word_frequency.blot`](word_frequency.blot)             | tokenize text, count sorted runs, and build an ordered text map             |

## Practical boundary cases

These examples include `Pain point:` comments at the relevant code, explicit
edge cases, evaluator goldens, and separate emitted-Wasm result goldens. They
return a `.default` value so each runs directly through the Node CLI.

- [`paginated_feed.blot`](paginated_feed.blot): bounded pages, continuation
  cursors, empty input, invalid limits, and an Int-maximum limit without adding
  untrusted bounds before clamping.
- [`unicode_preview.blot`](unicode_preview.blot): Unicode-scalar previews,
  zero/negative limits, ellipsis budgeting, and the distinction between scalar
  counts and grapheme clusters.
- [`idempotent_events.blot`](idempotent_events.blot): accepted deliveries,
  duplicate retries, conflicting payloads, invalid-then-corrected input, and an
  empty batch. The array-backed dictionary is a small-batch baseline, not a
  durable or constant-time deduplication service.
- [`sensor_units.blot`](sensor_units.blot): explicit Int/F64 conversion, typed
  float accumulation, an optional empty mean, and a named-operation workaround
  for the current generic float-loop inference limitation.
- [`stream_offsets.blot`](stream_offsets.blot): monotonic consumer checkpoints,
  duplicate/stale/gapped deliveries, empty input, and an Int-maximum checkpoint
  whose successor test is guarded so runtime addition cannot overflow.
- [`typed_transitions.blot`](typed_transitions.blot): a reusable `Transition`
  type constructor plus rank-polymorphic composition, tagged protocol states,
  one exhaustive error union, and valid/invalid/limit fixtures.

```sh
pnpm blot run examples/paginated_feed.blot
pnpm blot run examples/unicode_preview.blot
pnpm blot run examples/idempotent_events.blot
pnpm blot run examples/sensor_units.blot
pnpm blot run examples/stream_offsets.blot
pnpm blot run examples/typed_transitions.blot
```

Run `deno task verify:showcase` to evaluate the everyday programs, these five
boundary examples, and the graph showcases against their golden results and
compile each one through the semantic compiler. `pnpm test:node` also checks the
five boundary examples' exact emitted-Wasm outputs and canonical formatting.

See [the current-state review](../docs/review-2026-09-05-examples.md) for
findings, reproduction details, and the distinction between fixes and
workarounds.

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
