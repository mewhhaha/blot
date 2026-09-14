# Typed relational group join

`typed_relational_join.blot` factors an equijoin into a small structural
relation dictionary:

```blot
const On = fn (left, right, key) => {
  .left_key = left -> key;
  .right_key = right -> key;
  .equal = (key, key) -> Bool;
}
```

The one shared `Key` type connects both row projections and equality, so a
relation cannot silently compare unrelated key domains. `group` returns one
`Group (Left, Right)` per left row, preserving duplicate matches as multiple
values and unmatched rows as an empty `.matches` array. `flip` reverses the
relation while preserving the same key domain.

The executable reuses the same library for customer/order and product/line-item
joins. Reversing the customer/order relation demonstrates reuse in the opposite
direction, including an unmatched order. Empty-left and empty-right inputs cover
the identity edges. Two intentional rejection fixtures verify that a `ProductId`
projection cannot satisfy a `CustomerId` relation and that an unrelated row
array cannot be supplied as the right side of a customer/order relation.

The type system enforces row/key compatibility and the grouped result
relationship. It does not prove semantic laws of the supplied equality function
such as reflexivity or transitivity, nor uniqueness of keys; duplicate matches
are therefore ordinary supported data rather than a violation.

Run the example and focused tests with:

```sh
node --import tsx src/node/cli.ts check examples/typed_relational_join.blot
node --import tsx src/node/cli.ts run examples/typed_relational_join.blot
node --import tsx src/node/cli.ts lint --check examples/lib/relational_join.blot examples/typed_relational_join.blot
node --import tsx src/node/cli.ts build examples/typed_relational_join.blot
node --import tsx --test src/node/typed_relational_join.test.ts
```

The implementation freezes the right input once before capturing it in the
per-left predicate. Without that sharing boundary, the generic declaration
checks but its concrete use is rejected when the callback would repeatedly
consume the same array authority. The empty-left call needs no result
annotation: its precise inferred type is `[⊥]`, an empty array that is a subtype
of every array element type. It evaluates to `[]` and compiles normally. The
typed relation still constrains the supplied row arguments; an empty result does
not authorize an incompatible nonempty input.
