# Typed versioned schema migrations

`versioned_schema_migrations.blot` models an upgrade as
`Migration (From, To, Error) = From -> Result (To, Error)`. The reusable
`and_then` combinator shares one quantified intermediate schema between the
first migration's output and the second migration's input, while tagging each
stage's independent failure carrier as `#First` or `#Second`.

The concrete configuration example starts with two intentionally identical
record shapes whose `.timeout` field has different semantics: seconds in V1 and
milliseconds in V2. Explicit `#V1` and `#V2` constructors make that semantic
version part of the type even though the payload shape is unchanged. V3 then
renames the field to `.timeout_ms` and strengthens `.retry_limit` to the
`1..5` refinement. Composition therefore checks both schema adjacency and the
refined final payload without casts or an unchecked runtime registry.

The executable covers a successful two-stage upgrade, a first-stage invalid
seconds failure, a second-stage invalid retry-limit failure, and the inclusive
upper boundaries. Focused rejection fixtures prove that V2 cannot be passed to
a V1 migration, that migrations cannot be composed in reverse order, and that
`retry_limit = 8` cannot inhabit the V3 refinement.

The compiler guarantees carrier compatibility and the refinement boundary. It
does not prove domain laws such as whether multiplying seconds by 1000 is the
correct business conversion, whether a migration preserves every intended
field, or whether independent migrations form a lawful historical chain. Those
remain executable library contracts.

A more representation-efficient design would use distinct `seal` values for V1
and V2, avoiding runtime variant tags while retaining nominal separation. The
focused pressure program at `pending/versioned_nominal_migration.blot` records a
current specialization defect: even with canonical `@satisfies` requirements, a
wrong nominal source version checks to `⊥` while both evaluator and emitted Wasm
produce a concrete `#Ok`. Because that is not a sound supported-program claim,
the ordinary example uses explicit variants and the nominal form remains in the
catalog's `pending/` class until the checker is repaired.

Run the supported example and its focused tests with:

```sh
pnpm blot check examples/versioned_schema_migrations.blot
pnpm blot run examples/versioned_schema_migrations.blot
pnpm blot build examples/versioned_schema_migrations.blot
node --import tsx --test src/node/versioned_schema_migrations.test.ts
node scripts/check_abstractions.mjs
```

Expected successful observations include `timeout_ms = 30000` for 30 seconds,
`#First (#InvalidSeconds 90)`, `#Second (#InvalidRetryLimit 8)`, and acceptance
of the 60-second / retry-limit-5 boundary.
