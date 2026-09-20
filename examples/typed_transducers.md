# Typed transducers

`typed_transducers.blot` starts from a concrete monitoring problem: raw readings
need classification and selective alert extraction, but the transformation
pipeline should not choose how alerts are accumulated. `lib/transducer.blot`
factors that relationship into a small reducer-transformer API that composes
without intermediate application-level collections.

## Abstraction

A transducer changes the input accepted by a downstream reducer while preserving
that reducer's state and result types exactly:

```blot
const Transducer = fn (Input, Output) =>
  @forall (fn State =>
    @forall (fn Final =>
      R.Reducer (Output, State, Final) ->
        R.Reducer (Input, State, Final)
    )
  )
```

The committed source is formatter-canonical on one line, but the expanded form
makes the relationship easier to see. `State` and `Final` are quantified inside
the transducer, so an `Input -> Output` pipeline cannot assume anything about
how the eventual reducer accumulates or summarizes values.

The API has four operations:

- `identity` leaves the downstream reducer unchanged;
- `map` contramaps a total `Input -> Output` projection through a reducer;
- `choose_map` accepts `Input -> Option Output`, forwarding `#Some` values and
  leaving the downstream accumulator untouched on `#None`;
- `compose` shares the exact middle carrier between two transducers.

The executable specializes `Reading -> Classified -> Alert`. `Reading.score` is
refined to `0..100` and `.limit` to `1..100`. Classification retains those
fields and adds a boolean. `choose_map` then emits only readings above their
limit. The resulting `Reading -> Alert` transducer is applied to a reducer that
zips an alert count with total excess. The same transducer shape can be applied
to a different reducer without changing the transformation pipeline.

The compiler enforces the input/output carriers, the shared middle carrier used
by `compose`, the exact downstream reducer carrier, and the source refinements.
It does not prove semantic laws such as identity/associativity for arbitrary
user-supplied functions, nor does it prove that the business threshold is the
right monitoring policy.

## Edge cases

The executable covers an equality boundary (`score == limit`, which is not an
alert), a Unicode sensor name, a maximum legal score, an all-filtered input, an
empty input, and `identity`. The focused test also specializes `map` against a
reducer whose accumulator is an owned `[Int]`; evaluator and emitted Wasm both
produce `[2, 4, 6]`.

Intentional rejection fixtures verify that incompatible transducer stages do not
compose, a transducer cannot be applied to a reducer over the wrong output
carrier, and `101` cannot inhabit the `0..100` score refinement.

## Run

With the exact matching Rust/Wasm compiler artifact installed:

```sh
node --import tsx src/node/cli.ts check examples/typed_transducers.blot
node --import tsx src/node/cli.ts run examples/typed_transducers.blot
node --import tsx src/node/cli.ts build examples/typed_transducers.blot
node --import tsx src/node/cli.ts lint --check \
  examples/lib/transducer.blot examples/typed_transducers.blot
node --import tsx --test src/node/typed_transducers.test.ts
```

`deno task verify:showcase` exercises the catalog entry in environments with
Deno. `scripts/check_abstractions.mjs` registers the focused Node suite.

## Ownership boundary

A natural convenience helper is:

```blot
transduce :
  (Transducer (Input, Output),
   Reducer (Output, State, Final),
   [Input]) -> Final
```

with an implementation equivalent to `R.run (transducer reducer, values)`.
`examples/pending/transducer_generic_run.blot` records why that helper is not in
the supported API today: ownership is a post-inference flow analysis, so generic
`State` may contain an affine Array Store. Passing the reducer through an opaque
higher-rank transducer parameter does not publish a consuming ownership promise,
and the checker rejects the generic forwarding call with
`BLOT_LINEAR_ARGUMENT_NOT_OWNED`.

This is narrower than saying transducers cannot preserve owned state. They can:
the focused concrete owned-array probe checks, evaluates, and compiles. The
workaround is to specialize the transducer with the concrete reducer first and
then call `R.run`, as the supported executable does. No cast, freeze, copy, or
weakened state type is used.
