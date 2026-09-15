# Composable event aggregates

`event_aggregate.blot` factors an event-sourced decision model into four related
carriers:

```text
Aggregate (State, Command, Event, Error)
```

An aggregate owns an `initial` state, a `decide` function that turns a command
into typed events or a typed error, and an `evolve` function that folds accepted
events back into state. `execute` and `replay` reuse those relationships rather
than asking callers to repeat them.

The interesting combinator is `product`. Two unrelated aggregates become one
aggregate with tuple state and tagged command, event, and error sums. A left
command can only produce left events or a left error, and replay can only
consume the product event carrier. The concrete program composes a bounded
counter with an open/closed gate, then exercises both sides independently and by
replaying a mixed history.

The compiler enforces carrier compatibility, the `Amount = 1..100` refinement,
and the left/right wrappers exposed by the product. It does **not** prove event-
sourcing laws such as “every event emitted by `decide` makes sense to `evolve`”
or that replayed histories came from the decision function. Those remain library
contracts exercised by the focused tests.

## Run it

```sh
pnpm blot check examples/composable_event_aggregates.blot
pnpm blot run examples/composable_event_aggregates.blot
node --import tsx --test src/node/composable_event_aggregates.test.ts
```

The executable covers successful deposits and withdrawals, an insufficient
withdrawal, duplicate gate opening, both product command branches, tagged
failures from both product sides, a mixed event history, and empty-history
replay. Separate fixtures verify that a foreign event cannot be replayed and
that a command cannot be sent through the wrong product side.
