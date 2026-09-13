# Compiler findings from the ECS prototypes

These are limitations observed with compiler source at `ab2cfc8`, not additional
language rules. The runnable case study does not use these constructions. No
compiler changes accompany the study.

## A constructed handler cannot currently capture a runtime argument

Saving this source and running `pnpm blot check <path>` reports
`BLOT_UNBOUND: value is not in scope` at `supply value`:

```blot
open import "blot:prelude"
const Read = @effect { .get = Unit -> Int; }
const supply = fn value => { .get = fn ((), ?resume) => resume value; }
const run :: Int -> Int
const run = fn value => @handle (Read, fn () => Read.get (), supply value)
return run
```

Writing the clause directly in the `@handle` call works. Constructed handlers
with compile-time answers also work, as demonstrated by
[`schema_effects.blot`](../../examples/schema_effects.blot). The ECS resolver
therefore keeps its runtime captures in literal clauses.

## Merging stateful computations can skip work on a later row

This prototype checks successfully. Both evaluation and emitted Wasm produce
Positions `[8, 20]`; sequentially adding Velocity and doubling should produce
`[8, 44]`. Replacing the `merge` call with a directly written computation that
sequences `move` and `double` produces the expected result in the evaluator.

```blot
open import "blot:prelude"
const Row = { .Position = Int; .Velocity = Int; }
const State = @effect { .get = Unit -> Row; .set = Row -> Unit; }
const state = {
  .get = fn ((), ?resume) => fn row => do:
    use next <- resume (@satisfies row Row)
    return next row
  ;
  .set = fn (row, ?resume) => fn previous => do:
    use next <- resume ()
    return next row
  ;
  .return = fn () => fn row => row;
}
const merge = fn (left, right) => fn () => do:
  use left ()
  use right ()
  return ()
const move = fn () => do:
  use row <- State.get ()
  use State.set { .Position = row.Position + row.Velocity; .Velocity = row.Velocity; }
  return ()
const double = fn () => do:
  use row <- State.get ()
  use State.set { .Position = row.Position * 2; .Velocity = row.Velocity; }
  return ()
const movement = merge (move, double)
let apply :: Int -> [Row]
let apply = fn position => map (
  [{ .Position = position; .Velocity = 3; }, { .Position = 20; .Velocity = 2; }],
  fn row => (@handle (State, movement, state)) row
)
return { .default = apply 1; .apply = apply; }
```

The case study instead merges pure `Entity -> Entity` stages after resolving
their reader queries. Tests compare multiple rows and repeated ticks against an
independent model, rather than relying only on agreement between the evaluator
and Wasm.
