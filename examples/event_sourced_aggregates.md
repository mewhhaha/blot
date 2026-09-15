# Event-sourced aggregates

A command-oriented service often needs two views of the same domain rule: live
execution turns commands into new state, while recovery rebuilds state from a
stored event history. Returning both a next state and events from every command
handler duplicates that relationship and lets the two results drift.

`lib/event_sourced_aggregate.blot` factors the boundary into one reusable value:

```blot
Aggregate (State, Command, Event, Error)
```

An aggregate contains an initial state, `decide : (State, Command) ->
Result ([Event], Error)`, and `evolve : (State, Event) -> State`. A successful
`decide` can choose only events. `execute` derives the next state by folding
those events through the same `evolve` function used by `replay`; command code
therefore never returns a second independently computed state.

The `product` combinator composes two independent aggregates. Product state is a
pair, while product commands, events, and errors are tagged with `#Left` or
`#Right`. A command for one component can update only that component through the
corresponding event branch, and the other state is carried through unchanged.
No runtime type registry or erased payload is involved.

The executable combines an inventory aggregate with a rollout aggregate. The
inventory uses `Quantity = 1..100`; rollout uses `Percent = 0..100`. Interleaved
commands receive stock, reserve stock, advance rollout, and release a unit. The
recorded events replay to the same final pair of states. A maximum legal
quantity reaches the inventory policy and produces a typed insufficient-stock
error, while a rollout regression produces the independently typed rollout
error. Unicode labels remain ordinary state data.

## What the compiler enforces

The `Aggregate` parameters keep state, command, event, and error carriers
related at every generic boundary. `execute` cannot accept a command from
another domain, and `replay` cannot accept an event from another domain.
`product` preserves which component owns each command, event, and error. The
quantity and percentage refinements remain visible through product composition,
so an out-of-range command is rejected before execution.

The compiler does not prove the domain law that every arbitrary, well-typed
event history is valid from the aggregate's initial state. For example, a
syntactically valid `#Reserved 100` event could be supplied directly to `replay`
without having passed through `decide`. Persisted or external logs therefore
need provenance or validation appropriate to the application. The abstraction
claims carrier safety and one shared state-transition function, not a dependent
proof of history admissibility.

There is also a surface ergonomics boundary around explicit Rank-N signatures.
The names introduced inside a signature's `@forall` constrain the following
binding, but they are not lexical compile-time names in that binding's body.
`product` therefore relies on its checked outer signature and inferred local
functions rather than naming aliases such as `LeftState` inside the
implementation. The focused fixture
`src/node/fixtures/event_sourced_quantifier_scope.blot` records the current
`BLOT_UNBOUND` behavior directly.

## Run it

With the matching Rust/Wasm compiler artifact installed:

```sh
pnpm blot check examples/event_sourced_aggregates.blot
pnpm blot run examples/event_sourced_aggregates.blot
pnpm blot lint --check \
  examples/lib/event_sourced_aggregate.blot \
  examples/event_sourced_aggregates.blot
pnpm blot build examples/event_sourced_aggregates.blot
node --import tsx --test src/node/event_sourced_aggregates.test.ts
```

The recorded result contains the four tagged events, an inventory state with
seven available and three reserved units, rollout at 25 percent, and an
independently replayed state with the same values. The two rejected live
commands report `inventory:available=7` and `rollout:25->5`. Focused rejection
fixtures additionally cover a command from the wrong domain, an event from the
wrong replay domain, and an out-of-range refined quantity.
