# Staged bounded integer domains

`staged_bounded_domains.blot` turns one pair of compile-time integer bounds into a reusable runtime boundary API. `Domain.bounded (low, high)` computes `range (low, high)` once, then returns `contains`, `admit`, and `clamp` operations whose signatures are tied to that exact refinement.

The concrete program uses the same generator for deployment percentages, a narrower canary percentage, scheduling priority, and an allowed temperature range. `CanaryPercent.Type` is automatically usable where the wider `Percent.Type` is required because Blot's range types use ordinary set containment; the reverse direction is rejected.

## Why this abstraction

Without the descriptor, a program commonly repeats the same numeric bounds in a type declaration, a runtime validator, and a clamping function. Those copies can drift. Blot's types are compile-time values, so the descriptor factors that relationship directly: the bounds construct the output type, and branch narrowing proves that the successful runtime paths return values inside it. No cast or unchecked escape hatch is needed.

The compiler enforces the generated range membership, the return type of `admit`/`clamp`, ordinary refinement subtyping, and the `Int` input carrier. It does not attach domain meaning to equal numeric ranges. Two independently generated `-40..85` types are structurally the same even if an application informally calls one Celsius and the other Fahrenheit; semantic units need a distinct data model or nominal representation.

## Run it

With a Rust/Wasm compiler artifact matching the checkout:

```sh
pnpm blot check examples/staged_bounded_domains.blot
pnpm blot run examples/staged_bounded_domains.blot
pnpm blot build examples/staged_bounded_domains.blot
pnpm blot lint --check examples/lib/bounded_int_domain.blot examples/staged_bounded_domains.blot
node --import tsx --test src/node/staged_bounded_domains.test.ts
```

The focused test also checks canonical formatting, the evaluator golden, independently emitted Wasm output, and three rejection fixtures: widening a `0..100` value into `5..25`, constructing `1..5` with `6`, and passing text to an integer domain.

## Edge cases

The executable covers inclusive lower and upper bounds, just-outside rejection, clamping below and above the interval, negative bounds, a narrower range flowing into a wider range, and Boolean containment at the upper boundary. The abstraction intentionally does not claim that range equivalence proves application-level unit or version equivalence.
