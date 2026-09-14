# Typed reversible updates

`reversible_updates.blot` models a configuration change as a value that knows
both how to apply an input and which typed evidence is required to undo exactly
that change.

The reusable shape is:

```blot
Reversible (State, Input, Undo)
```

Its `apply` function returns the new state together with `Undo`; its `revert`
function accepts only the same state and undo carrier. `replace` lifts an
immutable getter/setter pair into a reversible field replacement, and `compose`
sequences two updates while pairing their inputs and undo evidence. Reverting a
composition runs the right update's undo first and the left update's undo
second.

The executable profile example composes a `Text` rename with a refined
`Quota = 1..100` replacement. `commit_if` then applies that same plan, validates
the changed profile, and rolls back with the evidence produced by the plan if
the policy rejects it. A quota of `40` commits; a quota of `80` returns the
original profile with `#QuotaTooHigh 80`.

The compiler enforces the state, input, and undo carrier relationships. In
particular, a reversed `(Quota, Text)` undo pair cannot be supplied to a plan
whose evidence is `(Text, Quota)`, unrelated state shapes cannot compose, and
`0` cannot inhabit the refined quota input. The type does **not** prove the
semantic inverse law `revert (apply state input) == state`; the concrete example
therefore exercises an explicit round trip in both the evaluator and emitted
Wasm.

Longer heterogeneous compositions intentionally retain their tuple tree in the
input and undo types. Left- and right-associated three-step plans therefore have
different structural evidence shapes. Keeping a long plan behind a named domain
function or record is the simple way to hide that representation detail.

Run the example and its focused tests with:

```sh
pnpm blot check examples/reversible_updates.blot
pnpm blot run examples/reversible_updates.blot
pnpm blot build examples/reversible_updates.blot
node --import tsx --test src/node/reversible_updates.test.ts
node scripts/check_abstractions.mjs
```

Expected observations are a changed profile `{ name = "Grace", quota = 40 }`, a
restored original profile, a committed valid change, and a rejected `quota = 80`
change whose returned state is the original `{ name = "Ada",
quota = 20 }`.
