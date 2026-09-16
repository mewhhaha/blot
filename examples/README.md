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
`pnpm blot run examples/<name>.blot`. Check formatting without loading the
semantic compiler with `pnpm format:check -- examples/<name>.blot`, or format
the file with `pnpm format -- examples/<name>.blot`. CI checks changed Blot
files before rebuilding the compiler.

[`record_view_results.blot`](record_view_results.blot) exercises a related
representation boundary: functions consume a `{ .count = Int; }` view of a wider
record and return fresh integer and text records with their own layouts.
[`lib/record_selection.blot`](lib/record_selection.blot) carries records with
nested variant fields through an array iterator and a selection fold; both array
alternatives remain available at runtime.
[`lib/shape_update_runtime.blot`](lib/shape_update_runtime.blot) preserves extra
record fields through a narrow parameter, applies runtime patches, and
enumerates runtime field values in insertion order.
[`deep_rebinding.blot`](deep_rebinding.blot) updates nested record fields, array
elements, and matrix cells by rebinding the root. Earlier record values remain
available and a loop carries the updated root.
[`lib/deep_rebinding_runtime.blot`](lib/deep_rebinding_runtime.blot) exercises
shared array snapshots, guarded runtime indices, and large record-update folds.

| Example                                                          | Abstraction                                                                                                                          | Observations                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [`nonempty_effect_stream.blot`](nonempty_effect_stream.blot)     | A nonempty producer becomes a sum, text, or its first element through different handlers                                             | `42`, `"10, 20, 12"`, and `10`; a singleton renders as `"7"`        |
| [`typed_effect_pipeline.blot`](typed_effect_pipeline.blot)       | A map handler translates an integer effect into a text effect; the next handler joins it                                             | `"$10 + $20 + $12"`                                                 |
| [`schema_effects.blot`](schema_effects.blot)                     | A record of types generates reader operations; a handler factory checks supplied settings against the same schema                    | `"localhost:8080"` and `"example.com:443"`                          |
| [`linear_transaction.blot`](linear_transaction.blot)             | An effect produces a linear pending transaction; commit and rollback consume it and return receipts                                  | `#Committed "order-42"` and `#RolledBack "order-42"`                |
| [`typed_quantities.blot`](typed_quantities.blot)                 | A compile-time descriptor couples a quantity type distinguished by its unit label to operations and generates typed unit conversions | `1550 m`, `155000 cm`, and `90 s`                                   |
| [`typed_lenses.blot`](typed_lenses.blot)                         | Composable lenses connect immutable nested updates through statically matched whole/part types                                       | `"London"` -> `"London / west"`; postal becomes `90210`             |
| [`composable_ordering.blot`](composable_ordering.blot)           | Typed key projection, reversal, and lexicographic tie-breakers compose one reusable `Order Ticket`                                   | priority desc; team/id asc; equal keys stay stable                  |
| [`typed_nonempty.blot`](typed_nonempty.blot)                     | A head-plus-tail collection is statically nonempty while satisfying structural collection interfaces                                 | first `"Ada"`, length `4`, total weight `11`, and typed route       |
| [`structural_readers.blot`](structural_readers.blot)             | Pure `Reader (Env, A)` composition accumulates narrow structural capabilities and lifts nested environments                          | `"EUR 12500"` and `"EUR 11100"`                                     |
| [`typed_validation.blot`](typed_validation.blot)                 | Independent validators accumulate typed failures while refinement outputs encode accepted bounds                                     | three invalid fields accumulate; legal maxima pass                  |
| [`effect_row_middleware.blot`](effect_row_middleware.blot)       | Composable wrappers add tracing/metrics while preserving arbitrary callback effect rows                                              | `252` effectful, `251` pure; callback effects stay visible          |
| [`composable_reducers.blot`](composable_reducers.blot)           | Typed reducers contramap inputs, map outputs, and zip independent accumulators into one fold                                         | revenue `3500`, units `6`, lines `3`; empty and singleton reports   |
| [`typed_semiring_matrices.blot`](typed_semiring_matrices.blot)   | One typed matrix product runs over integer path counts and optional min-plus route costs                                             | two-step walk counts plus cheapest reachable two-leg costs          |
| [`nominal_keyed_index.blot`](nominal_keyed_index.blot)           | Generated key types keep distinct indexes separate while lookup infers its optional payload                                          | user `#Some "Ada"`, project `#Some "compiler"`, missing `#None`     |
| [`composable_parser.blot`](composable_parser.blot)               | Typed parser combinators sequence Unicode-safe cursor parsers and preserve one result carrier through choice                         | health, Unicode user, and asset routes plus precise failures        |
| [`composable_prisms.blot`](composable_prisms.blot)               | Structural prisms compose partial focuses through one shared intermediate type                                                       | nested event preview, update-on-match, misses, and review           |
| [`derived_structural_diff.blot`](derived_structural_diff.blot)   | Checked scalar field evidence generates a schema-indexed structural differ reused by unrelated records                               | changed field names, exact equality, and refined-field bounds       |
| [`staged_request_builder.blot`](staged_request_builder.blot)     | Required slots are type parameters; consuming setters advance either order while preserving the other slot                           | Two receipts; invalid stages reject statically                      |
| [`typed_codec.blot`](typed_codec.blot)                           | Bidirectional codecs compose validated fields while preserving model, wire, and error types                                          | round trips, boundary values, and typed decode errors               |
| [`deferred_fallback.blot`](deferred_fallback.blot)               | Affine deferred fallback expressions preserve one success carrier while replacing or pairing independently typed errors              | cache hit skips fallback; store hit; paired errors remain typed     |
| [`residual_command_router.blot`](residual_command_router.blot)   | Typed routing stages forward exact residual variants; composition can only pass cases the previous stage left unresolved             | create, rename, delete, and final health resolution                 |
| [`typed_coordinate_spaces.blot`](typed_coordinate_spaces.blot)   | Generated space descriptors and composable transforms keep points and vectors in matched coordinate frames                           | model/world/screen composition, vector semantics, static mismatches |
| [`reversible_updates.blot`](reversible_updates.blot)             | Reversible updates compose exact input/undo evidence and roll back failed validation with matching typed evidence                    | apply, round-trip restore, commit, rollback, and static mismatches  |
| [`typed_relational_join.blot`](typed_relational_join.blot)       | Typed key projections connect two row domains and preserve grouped matches                                                           | duplicates, unmatched rows, empty sides, flipped relations          |
| [`typed_traversals.blot`](typed_traversals.blot)                 | Composable zero-or-more focuses preserve the relationship between whole values and their parts                                       | nested arrays, empty waves, Unicode labels, incompatible modifiers  |
| [`typed_record_projections.blot`](typed_record_projections.blot) | A staged field selection derives a shared shape for typed observation and replacement                                                | refinements, unselected fields, empty selections, unknown names     |
| [`staged_endpoint_adapters.blot`](staged_endpoint_adapters.blot) | Staged higher-kinded constructors generate Rank-N adapters that change endpoint result context without changing payload types        | refined ports, missing values, Unicode text, static carrier checks  |

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
the structural type lattice; its `.type` member carries the unit-specific type
into generic checked signatures without runtime dispatch.

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

The structural-reader example is deliberately pure. Tax, shipping, and currency
computations name only the record capabilities they consume. `zip_with` closes
those narrower function inputs at a wider structural boundary, while `local`
lifts pricing under an application field. A refined percentage field and two
negative fixtures make missing or invalid capabilities type errors before
execution; extra outer and nested record fields remain valid through width and
depth subtyping.

The validation example treats a check as `Input -> Result (Value, [Error])`.
`zip_with` shares one input and error carrier across independent checks, so
failures accumulate instead of short-circuiting. Successful leaves strengthen
ordinary integer fields into refinements before the final config is built.

The middleware example keeps its callback row open: `traced` and `counted` add
named observability effects while direct composition preserves any unrelated
callback effects instead of hiding them behind a runtime registry.

The semiring example uses ordinary structural dictionaries and type-valued
matrices; it checks carrier compatibility statically, while algebraic laws
remain executable library contracts rather than compiler proofs.

The parser example uses `Text.Cursor` as ordinary immutable parser state. `map`
changes the parsed value, `zip_with` sequences different result types, and
`or_else` backtracks while retaining the failure at the farthest byte offset.
`run` closes the abstraction by requiring complete input consumption.

The typed codec example composes two independently validated integer fields.
Each leaf codec keeps its narrow error constructor, while algebraic subtyping
widens those errors to the application-level union at the product boundary.
`imap` requires both directions of a representation change, so a one-way remap
cannot masquerade as a codec. Product decoding is intentionally left-biased on
errors; the example records that behavior rather than claiming accumulation.

The deferred-fallback example treats recovery as a typed control-flow boundary
rather than an eager value. `recover` can replace the primary error carrier,
while `recover_with_context` proves that any final failure contains both
independent errors. Its affine `~>` parameter means an already-successful
primary result does not evaluate the fallback expression; the effectful case
also demonstrates that static effect rows conservatively include a fallback
effect even when one runtime branch skips it.

The residual-router example makes a decision list's remainder explicit in its
type. Each stage returns `Result (Output, Remaining)`, while closed type
difference computes `AfterCreate`, `AfterRename`, and `AfterDelete`. `then`
shares each residual with the next stage, so an already handled constructor
cannot be forwarded again and `finish` requires a resolver for every final
remaining case. Blot has no surface empty type, so the chain ends with one
concrete final resolver rather than subtracting the last alternative to empty.

The coordinate-space example specializes a small descriptor per singleton frame,
so within-space operations are monomorphic while reusable transforms quantify
over their source and destination frames. `compose` shares its middle frame in
both function-result and function-input positions, and points stay distinct from
vectors so translation cannot accidentally affect a displacement. The explicit
frame marker is runtime data; the example does not claim a zero-cost phantom
type.

The reversible-update example turns an immutable getter/setter pair into a
`Reversible (State, Input, Undo)` plan whose `apply` result carries exactly the
evidence accepted by `revert`. Composition pairs both input and undo carriers,
while `commit_if` uses the produced evidence to roll back failed validation. The
type checks carrier compatibility; inverse laws remain executable contracts.

The staged-endpoint-adapter example starts from a concrete boundary problem: one
endpoint may return a cache-style optional result while another layer wants a
checked or observed result, but the endpoint payload itself must not change.
`Natural (Source, Target)` is Rank-N in that payload, and `hoist` reuses the
same adapter for unrelated endpoint input/output pairs. Blot has no
higher-kinded inference variable, so `compose` and `hoist` are generated by
ordinary compile-time functions from concrete type constructors; ordinary
payload polymorphism remains checked in the generated arrows. Run it with
`pnpm blot run examples/staged_endpoint_adapters.blot`.

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

The endpoint adapter's returned Rank-N scheme is now retained through an
inferred binding. Its regression test asserts `Observed Text` through checking,
evaluation, and emitted Wasm; repeating the `Natural (Maybe, Observed)`
signature is no longer required. This uses the same compiler repair exercised by
the aggregate example in PR #143.

The deliberately heterogeneous endpoint instantiations currently emit one
`BLOT_LINT_SPECIALIZATION_COUNT` advisory in `hoist`. The repair does not
suppress that representation-count warning or claim a performance measurement.
