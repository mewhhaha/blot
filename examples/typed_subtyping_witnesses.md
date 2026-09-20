# Checked subtyping witnesses

`Witness (Source, Target)` packages a no-op `Source -> Target` conversion.
`derive` asks the compiler to check the identity implementation against that
arrow; it does not approximate the compiler with a second reflection predicate.
`compose` shares the middle type, and `adapt` reuses a consumer of a wider view
for a richer input. The executable composes record-width subtyping with a
refined port and also widens a closed variant union.

## Run and verify

```sh
pnpm blot check examples/typed_subtyping_witnesses.blot
pnpm blot run examples/typed_subtyping_witnesses.blot
pnpm blot build examples/typed_subtyping_witnesses.blot
node --import tsx --test src/node/typed_subtyping_witnesses.test.ts
```

The evaluator and emitted Wasm independently produce the endpoint
`/v1/🐱:65535`, route `/v1/🐱`, and descriptions of both healthy alternatives.
Negative tests reject a missing required field, two incompatible composition
carriers, and port `65536`. They assert `BLOT_TYPE_ERROR`, not an incidental
syntax error or a refusal during creation of an otherwise valid witness.

## Design boundaries

The type proves that the identity implementation is a safe structural view. It
does not prove a business conversion such as seconds to milliseconds. Named
`Witness` signatures at the staged construction boundaries currently preserve
more useful source/target information than inferred bindings; the example keeps
those explicit rather than weakening either side of the relation.

The earlier reflection-based derivation rejected valid union widening. The
prelude now checks every narrow alternative against the complete wide type:
`refines (#A | #B, #A | #B | #C)` evaluates to `True`, and the reverse direction
remains `False`. Regression coverage includes option fields, nested records,
integer unions and incompatible payloads. The abstraction continues to delegate
its identity proof directly to the checked arrow.

The three distinct record/union instantiations intentionally exercise reuse.
Blot's lint therefore reports `BLOT_LINT_SPECIALIZATION_COUNT` for `derive` and
`adapt` (three representations each). This is a visible specialization tradeoff,
not suppressed or described as a measured performance defect.
