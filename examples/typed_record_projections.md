# Typed record projections

This example derives a reusable multi-field view from one concrete record schema
and a compile-time list of field names. `Projection (Whole, Part)` relates the
whole record, the selected record, observation, and replacement in one small
structural API. `fields` computes `Part` with `Reflect.pick`, so callers do not
repeat a patch schema or weaken it to a dynamic map.

The deployment example derives a `{ .host; .port }` network projection and a
singleton `{ .replicas }` capacity projection. The selected `port` and
`replicas` fields retain their predicate refinements, replacement preserves
unselected fields such as `.owner`, and `over` requires a `Part -> Part`
transformation. The same generator is reused for an unrelated profile record. An
empty selection is also valid: it observes `{}` and replacement is the identity
for the whole record.

The compiler enforces the selected field carriers and the exact selected shape.
It does not prove semantic projection laws for arbitrary manually constructed
`Projection` records; the generated `fields` implementation and executable round
trips provide that library behavior.

Run the example and focused tests with:

```sh
node --import tsx src/node/cli.ts check examples/typed_record_projections.blot
node --import tsx src/node/cli.ts run examples/typed_record_projections.blot
node --import tsx src/node/cli.ts lint --check examples/lib/record_projection.blot examples/typed_record_projections.blot
node --import tsx src/node/cli.ts build examples/typed_record_projections.blot
node --import tsx --test src/node/typed_record_projections.test.ts
```

The focused rejection fixtures cover an invalid refined replacement, a missing
selected field, and an unknown compile-time field name. The PR description
records the diagnostic and record-row design friction found while deriving the
abstraction.
