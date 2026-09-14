# Typed coordinate spaces

`coordinate_space.blot` turns an ordinary singleton variant such as `#Model` or
`#Screen` into a small coordinate-space descriptor. The descriptor owns exact
point/vector constructors plus `between` and `move`, while reusable
`Transform (From, To)` values convert between spaces and compose only when the
middle space agrees.

The example uses three spaces: model coordinates are translated into world
coordinates, then world coordinates are scaled and Y-flipped into screen
coordinates. The same composed transform is reused for an array of points and a
displacement vector. Because points and vectors are distinct types, translation
is present only in the point transform; vectors carry scale/orientation changes
without an accidental positional offset.

The compiler enforces the concrete frame marker, rejects a model-space move by a
world-space vector, and rejects composition whose adjacent spaces do not match.
The marker is an ordinary runtime field, not a zero-cost phantom type. Also,
repeating a covariant quantified type variable does not mean nominal equality in
Blot's algebraic-subtyping relation: the focused test records that a naïve
generic same-frame helper can widen `#Model` and `#World` to their union. The
safe API therefore specializes a space descriptor before exposing within-space
operations.

Run the example and its focused checks from the repository root:

```sh
pnpm blot check examples/typed_coordinate_spaces.blot
pnpm blot run examples/typed_coordinate_spaces.blot
pnpm blot build examples/typed_coordinate_spaces.blot
node --import tsx --test src/node/typed_coordinate_spaces.test.ts
node scripts/check_abstractions.mjs
```

Expected execution maps model points `(0, 0)`, `(3, 2)`, and `(-4, 1)` to screen
points `(200, -100)`, `(206, -104)`, and `(192, -102)`. The model displacement
`(3, 2)` becomes screen displacement `(6, -4)`, moving the transformed origin to
the transformed target.
