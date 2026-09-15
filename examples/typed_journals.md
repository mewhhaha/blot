# Composable typed journals

`typed_journals.blot` starts from a common application problem: independent
planning steps should return useful values while also recording an ordered audit
trail. Requiring every step to know one application-wide event union would make
those components less reusable, while erasing entries to `Text` would throw away
useful type information before the application chooses how to observe it.

The reusable API in `examples/lib/journal.blot` keeps the two concerns separate:

```blot
const Journal = fn (Entry, Value) => {
  .entries = [Entry];
  .value = Value;
}
```

`map` changes only the result value, `map_entries` changes only the event
vocabulary, `and_then` sequences a journal-producing step, and `zip_with`
combines independently produced journals. `pure` supplies a value with an empty
audit trail and `emit` supplies one typed entry.

The important Blot-specific property is how the `Entry` variable behaves at a
call. Variants are structurally covariant. When one stage produces
`Journal (#Placed ..., Placement)` and the next produces
`Journal (#Capacity ..., Placement)`, the single quantified `Entry` in
`and_then` is solved to the common structural union. The application therefore
gets `Journal (PlacementEvent | CapacityEvent, Placement)` without either leaf
component importing or duplicating the application union.

By contrast, the intermediate `Input` in `and_then` appears as the first
journal's result and as the next function's parameter. Those opposite variance
positions preserve the useful value relationship: a stage returning `Int`
cannot be followed by one that requires `Text`. `map_entries` is available when
a caller deliberately wants a different observation vocabulary; the executable
uses it to render typed audit variants as text only after planning is complete.

## Concrete use

The example plans two services. `choose_zone` owns only `PlacementEvent` and
`record_capacity` owns only `CapacityEvent`; `plan` composes them and exposes the
inferred application union. The API service exercises Unicode text and an
ordinary HTTPS port. The worker uses the maximum accepted `ReplicaCount` of 16.
`zip_with` combines the independent service plans while retaining entry order,
and `pure` covers the empty-journal case. The result also demonstrates that
`map` changes the plan result without touching entries and that `map_entries`
can explicitly translate the event carrier.

The refinements in the concrete data model are compiler-enforced:
`Port = 1..65535` and `ReplicaCount = 1..16`. The focused rejection fixtures
also prove that a journal result cannot feed a callback expecting an unrelated
value carrier, an entry mapper cannot consume the wrong source variant, and an
out-of-range replica count is rejected before execution.

Journal ordering and any domain meaning assigned to emitted entries are library
semantics rather than compiler proofs. `Array.append` gives the implementation
its left-to-right order; the compiler checks carriers and ownership, not an
application-level audit law such as “every placement must be followed by a
capacity event.”

## Variance boundary

A repeated quantified variable is not nominal equality in Blot's algebraic
subtyping system. The supported probe
`src/node/fixtures/journal_entry_join.blot` composes `#First Int` and
`#Second Text` journals through the generic `and_then`; checking it yields
`[#First Int | #Second Text]` rather than rejecting the call. This is exactly the
behavior used by the example, but it is an important API-design boundary: a
library that needs *exactly one closed event carrier* should not assume repeated
covariant occurrences encode equality. It must introduce an invariant
relationship or specialize/stage the carrier instead.

No compiler correctness or performance defect is claimed by this example. The
focused test records the union result so a future variance or principal-type
change cannot silently turn this API property into a different one.

## Run

With a Rust/Wasm compiler artifact matching the checkout:

```sh
pnpm blot check examples/typed_journals.blot
pnpm blot run examples/typed_journals.blot
pnpm blot lint --check examples/lib/journal.blot examples/typed_journals.blot
pnpm blot build examples/typed_journals.blot
node --import tsx --test src/node/typed_journals.test.ts
node scripts/check_abstractions.mjs
```

Evaluator and emitted-Wasm observations are recorded independently under
`examples/expected/`. The three negative fixtures are intentional source-level
rejections; `journal_entry_join.blot` is a supported checker probe, not a pending
or rejected program.
