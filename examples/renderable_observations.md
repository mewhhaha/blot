# Renderable observations

This example solves a concrete reporting problem: one deployment summary needs to
keep ports, replica counts, health states, owner text, and optional zones in one
homogeneous collection even though those values have unrelated types. Converting
every value to `Text` before collection would work, but it would also throw away
the useful relationship between each source value and the renderer that knows
how to format it.

`lib/renderable.blot` keeps that relationship with a small Church-encoded
existential:

```blot
const Renderable =
  @forall (fn Result =>
    @forall (fn Value => (Value, (Value -> Text)) -> Result) -> Result
  )
```

`make` can hide any `Value`, but the paired renderer must accept that exact
`Value` type. `render` is the only ordinary eliminator the example needs. Its
consumer is explicitly rank-polymorphic, so it cannot assume whether a packed
observation contains a refined integer, text, a variant, or an option.

The compiler therefore checks two useful boundaries independently:

- construction rejects a renderer for the wrong hidden value type;
- elimination rejects a monomorphic consumer that tries to assume a particular
  hidden type.

The abstraction does not prove that a renderer is semantically truthful. A
`Port -> Text` function could still print an unrelated label; that is ordinary
application behavior rather than a type-system guarantee.

The executable stores five different observation carriers in `[R.Renderable]`,
including `Port = 1..65535`, `ReplicaCount = 1..32`, a health variant, Unicode
owner text, and `Option Text`. It also renders an explicitly typed empty
collection, which preserves `[R.Renderable]` rather than relying on an
unconstrained empty literal.

Run it from the repository root:

```sh
pnpm blot check examples/renderable_observations.blot
pnpm blot run examples/renderable_observations.blot
pnpm blot build examples/renderable_observations.blot
pnpm blot lint --check examples/lib/renderable.blot examples/renderable_observations.blot
node --import tsx --test src/node/renderable_observations.test.ts
```

The focused test compares evaluator and emitted-Wasm results against independent
goldens and checks both static rejection boundaries.
