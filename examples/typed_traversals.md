# Typed traversals

This example factors a common configuration problem into a reusable zero-or-more
focus. A `Traversal (Whole, Part)` can collect every `Part` inside one `Whole`
and modify every focus while returning the same `Whole` type.

`one` lifts an exactly-one projection/setter pair, `each` focuses every element
of a homogeneous array, and `compose` requires the outer part and inner whole to
be the same `Middle` type. That shared type is the important static invariant:
non-adjacent paths cannot compose, and `over` must return the focused `Part`
type. No casts or host implementation are involved.

The deployment-plan executable composes `each` twice to traverse deployment
waves and then composes an exactly-one probe-label focus. It exercises multiple
waves, an empty wave, an empty whole plan, Unicode text, and preservation of an
unfocused URL.

Run it with:

```sh
node --import tsx src/node/cli.ts check examples/typed_traversals.blot
node --import tsx src/node/cli.ts run examples/typed_traversals.blot
node --import tsx src/node/cli.ts lint --check examples/lib/traversal.blot examples/typed_traversals.blot
node --import tsx src/node/cli.ts build examples/typed_traversals.blot
node --import tsx --test src/node/typed_traversals.test.ts
```

The structural interface does not prove traversal laws such as identity or
composition equivalence; those are library laws and are covered behaviorally.
The PR description also records ownership and inference friction found while
building natural variants of the abstraction, together with exact validation
limits for the currently available compiler artifact.
