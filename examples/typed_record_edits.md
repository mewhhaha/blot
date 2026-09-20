# Typed record edits

This example factors immutable configuration changes into a small schema-indexed
edit algebra. `Edit Whole` is simply `Whole -> Whole`; `then` composes two edits
only when they share the same `Whole`, and `empty` is the identity edit. The
staged `field (Whole, name)` constructor computes one field's `Part` with
`@shape.get` and returns `replace : Part -> Edit Whole` plus
`modify : (Part -> Part) -> Edit Whole`.

That small relationship makes nesting fall out of ordinary function typing. An
`Edit Limits` already has type `Limits -> Limits`, exactly the callback expected
by the outer service `.limits` field's `modify`, so a nested edit lifts without
a second optic/composition API. Refinements remain attached to each `Part`: the
port editor accepts `1..65535`, the burst editor accepts `1..100`, and unrelated
record edits cannot be sequenced by `then`. Unknown field names fail while the
field descriptor is staged.

The executable builds a service rollout that modifies Unicode text, replaces a
refined port, lifts a nested limits edit, and updates an `Option Text`. It also
covers the identity edit, same-field sequencing (the later edit wins by ordinary
function composition), the maximum legal port, and reuse for an unrelated
profile schema.

The compiler enforces field existence, exact field carriers, refinements, the
`Part -> Part` modifier contract, and the shared `Whole` in `then`. It does not
prove extensional laws such as associativity of arbitrary user-supplied
endomorphisms; `empty` and `then` implement the conventional endomorphism
identity/composition directly.

Run the example and focused tests with:

```sh
node --import tsx src/node/cli.ts check examples/typed_record_edits.blot
node --import tsx src/node/cli.ts run examples/typed_record_edits.blot
node --import tsx src/node/cli.ts lint --check examples/lib/record_edit.blot examples/typed_record_edits.blot
node --import tsx src/node/cli.ts build examples/typed_record_edits.blot
node --import tsx --test src/node/typed_record_edits.test.ts
```

The focused rejection cases cover an out-of-range replacement, composition of
edits for unrelated record schemas, and an unknown compile-time field name. The
pending pressure case at `examples/pending/record_edit_guarded_increment.blot`
records a separate language-design limitation: guarding `value < 100` narrows
the input, but `value + 1` currently has type `Int` rather than a range-derived
result. A redundant bounds check on the computed successor can recover the
refinement; the supported example does not claim that range arithmetic
postcondition today.
