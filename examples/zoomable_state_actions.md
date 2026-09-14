# Zoomable state actions

`state_action.blot` packages a stateful computation as `Action (State, Value) =
State -> Step (State, Value)`. The same `State` occurs on both sides of the
arrow, so a reusable action cannot silently change the carrier it threads while
its observation type remains independent.

The useful operation is `zoom`. Given a `Lens (Whole, Part)` and an `Action
(Part, Value)`, it produces an `Action (Whole, Value)`: the local computation
runs only on the focused part and the lens rebuilds the outer state. The same
`Part` appears in both arguments, so an action for metrics cannot be localized
through a profile lens. `and_then`, `map`, and `sequence` reuse the same state
carrier without introducing a runtime framework.

The executable models an application with a profile and metrics. A name
replacement is zoomed through two nested lenses, quota replacement uses a
composed lens, and a metrics counter is localized independently. `sequence`
combines the three actions into one pass over the application state, returning
the old name, old refined quota, and new request count. `pure` exercises the
identity edge and `map` changes only an observation.

The compiler guarantees the state/focus carrier relationships and retains the
`Quota = 1..100` refinement. It does not prove semantic lens laws such as
`set (whole, view whole) == whole`; those are library laws rather than ordinary
function-type facts.

Run the example with:

```sh
pnpm blot check examples/zoomable_state_actions.blot
pnpm blot run examples/zoomable_state_actions.blot
pnpm blot build examples/zoomable_state_actions.blot
pnpm blot lint --check examples/lib/state_action.blot examples/zoomable_state_actions.blot
node --import tsx --test src/node/zoomable_state_actions.test.ts
```

The focused suite also verifies three intentional type rejections: zooming a
profile action through a metrics lens, sequencing actions with different state
carriers, and replacing a refined quota with `0`. A syntax pressure fixture
records the current need to parenthesize or destructure adjacent numeric tuple
projections such as `value.result.1.0`.
