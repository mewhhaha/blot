# Bidirectional compatibility bridges

Compatibility boundaries are often asymmetric. A legacy representation can
contain values that the canonical model no longer accepts, while the canonical
model can contain values that the legacy representation cannot express. A
single `A -> Result B E` migration captures only one half of that problem.

`lib/bidirectional_bridge.blot` factors the common relationship into:

```blot
Bridge (Left, Right, ForwardError, BackwardError)
```

with `to_right : Left -> Result (Right, ForwardError)` and
`to_left : Right -> Result (Left, BackwardError)`. `compose` shares the exact
middle carrier between adjacent bridges and tags failures with `#First` or
`#Second`, while `reverse` swaps both carriers and both directional error types.

The executable models three independently versioned role vocabularies: a legacy
API, a canonical domain model, and a partner API. It demonstrates successful
translation, a rejection at each forward stage, a rejection at each backward
stage, reversal, Unicode payloads, and an explicitly specialized identity
bridge.

## Static guarantees

The compiler enforces the four carrier relationships in each bridge. Two
bridges compose only when the first right carrier is usable as the second left
carrier. `reverse` cannot accidentally keep the old error directions, and each
composed failure keeps the error carrier of the stage that actually rejected the
value. The fixtures verify incompatible middle carriers, calling the wrong
direction with a left-side value, and implementing a bridge that returns a
foreign right-side constructor.

The compiler does not prove semantic round-trip laws. A type-correct bridge can
normalize information, reject asymmetrically, or map two source values to one
destination value. Applications that require `to_left (to_right x) == x` must
test or establish that law separately.

## Run it

With a Rust/Wasm compiler artifact matching the checkout:

```sh
node --import tsx src/node/cli.ts check examples/bidirectional_compatibility.blot
node --import tsx src/node/cli.ts run examples/bidirectional_compatibility.blot
node --import tsx src/node/cli.ts lint --check \
  examples/lib/bidirectional_bridge.blot \
  examples/bidirectional_compatibility.blot
node --import tsx src/node/cli.ts build examples/bidirectional_compatibility.blot
node --import tsx --test src/node/bidirectional_compatibility.test.ts
```

## Design tradeoff

`Bridge` uses one uniform partial representation in both directions instead of
splitting total and partial arrows into multiple combinator families. This keeps
composition small and preserves stage-specific errors, but Blot currently has no
surface empty type value that can stand for an impossible `Result` error. The
infallible `identity` therefore quantifies otherwise-unused forward/backward
error carriers; callers can specialize them from context, as the executable
does. No fake runtime error constructor, cast, or unchecked escape is introduced.
