# Dimensional quantities

`lib/dimensional_quantity.blot` is a small staged dimension algebra for integer
quantities. A dimension is a compile-time exponent vector with `.length` and
`.time` components. `make` turns one vector into a quantity descriptor, while
`multiply` and `divide` derive the result vector by compile-time exponent
arithmetic.

The concrete example starts with length and time, derives speed from
`Length / Time`, derives distance again from `Speed * Time`, derives area from
`Length * Length`, and derives a dimensionless scalar from `Length / Length`.
The separately declared `Speed`, `Area`, and `Scalar` descriptors accept those
derived results because their singleton dimension markers are structurally the
same types.

This is deliberately different from `typed_quantities.blot`: that example keeps
named units distinct and demonstrates explicit scaling between them. This
example focuses on algebra over dimensions, so multiplication and division
compute result types instead of naming each conversion by hand.

## What the compiler guarantees

The dimension marker is part of `Quantity Dimension`, so addition accepts only
identical dimensions. `multiply` and `divide` share the exact input descriptor
types and compute the result descriptor from their compile-time exponent
vectors. The rejection fixtures verify that a time cannot be added to a length,
a derived speed cannot be claimed as a length, and a length cannot be supplied
where a speed operand is required.

Division's zero check is runtime validation rather than a type-level proof:
`divide` returns `#None | #Some result.type` and yields `#None` for a zero
divisor. The compiler does not prove physical-unit semantics, positivity,
overflow freedom, or that the two-axis vector is sufficient for a caller's
entire domain.

## Why the marker is explicit

Blot's ordinary structural type constructors do not have a separate phantom
parameter mechanism. If a constructor accepts `Dimension` but never mentions it
in the resulting carrier, two applications with different dimensions are the
same structural type.
`src/node/fixtures/dimensional_quantity_phantom_erasure.blot` records that
behavior directly: a value built at the time specialization flows into a length
consumer because both reduce to `{ .value = Int; }`.

The supported abstraction therefore stores the singleton exponent record in the
quantity carrier. This is honest about the static distinction instead of
pretending an unused compile-time parameter creates nominal identity. When a
zero-field identity is required instead of structural dimension equality, a
sealed/nominal carrier is the appropriate separate design choice.

## Run

With a Rust/Wasm semantic compiler artifact matching the checkout:

```sh
pnpm blot check examples/dimensional_quantities.blot
pnpm blot run examples/dimensional_quantities.blot
pnpm blot lint --check examples/lib/dimensional_quantity.blot examples/dimensional_quantities.blot
pnpm blot build examples/dimensional_quantities.blot
node --import tsx --test src/node/dimensional_quantities.test.ts
```

The executable covers ordinary composition, a zero divisor, a dimensionless
result, Unicode display text, and three intentional static rejection boundaries.
Evaluator and emitted-Wasm expectations are stored independently under
`examples/expected/`.
