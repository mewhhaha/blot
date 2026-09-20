# Staged bounded integer domains

`staged_bounded_domains.blot` turns one concrete compile-time integer range type
into a reusable runtime boundary API. `Domain.bounded Type` reflects that type's
endpoints once, then returns `contains`, `admit`, and `clamp` operations whose
signatures are tied to the exact same refinement.

The concrete program uses the same generator for deployment percentages, a
narrower canary percentage, scheduling priority, and an allowed temperature
range. `CanaryPercent.Type` is automatically usable where the wider
`Percent.Type` is required because Blot's range types use ordinary set
containment; the reverse direction is rejected.

## Why this abstraction

Without the descriptor, a program commonly repeats the same numeric bounds in a
type declaration, a runtime validator, and a clamping function. Those copies can
drift. Blot's types are compile-time values and `Reflect.of` exposes a range's
ordered-domain metadata, so the refinement itself becomes the single source of
truth. Branch narrowing proves that successful runtime paths return values
inside it. No cast or unchecked escape hatch is needed.

The compiler enforces the generated range membership, the return type of
`admit`/`clamp`, ordinary refinement subtyping, and the `Int` input carrier. It
does not attach domain meaning to equal numeric ranges. Two independently
constructed `-40..85` types are structurally the same even if an application
informally calls one Celsius and the other Fahrenheit; semantic units need a
distinct data model or nominal representation.

The first draft did not execute: it attempted to bind generated signatures
inside a reflection case, and the checker only used literal integer bounds as
branch evidence. The generator now selects reflection metadata before declaring
its API, and the Rust checker accepts stable compile-time bound bindings and
record fields. It does not use runtime parameters or arbitrary comparison
callbacks as proof. Native and evaluator/Wasm regressions cover that boundary.

`admit` constructs `#Some value` directly. During this repair, the generic
prelude `Some` wrapper was observed accepting an out-of-range payload under an
expected refinement even without a guard; the direct variant constructor
correctly rejects it. This is a pre-existing generic-application checking
defect, not a claim that the repaired domain admits invalid values. The public
domain's refinement proof is checked before the variant leaves the generated
function.

## Run it

With a Rust/Wasm compiler artifact matching the checkout:

```sh
pnpm blot check examples/staged_bounded_domains.blot
pnpm blot run examples/staged_bounded_domains.blot
pnpm blot build examples/staged_bounded_domains.blot
pnpm blot lint --check examples/lib/bounded_int_domain.blot examples/staged_bounded_domains.blot
node --import tsx --test src/node/staged_bounded_domains.test.ts
```

The focused test also checks canonical formatting, the evaluator golden,
independently emitted Wasm output, and rejection fixtures for runtime-only
bounds, unrecognized comparisons, and: narrowing a general `0..100` value into
`5..25`, constructing `1..5` with `6`, and passing text to an integer domain.

## Edge cases

The executable covers inclusive lower and upper bounds, just-outside rejection,
clamping below and above the interval, negative bounds, a narrower range flowing
into a wider range, and Boolean containment at the upper boundary. The
abstraction intentionally does not claim that range equivalence proves
application-level unit or version equivalence.
