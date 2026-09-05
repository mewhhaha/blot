# Language review: implemented library extensions

These modules are ordinary Blot source. They do not add primitives, grammar,
implicit imports, or a second semantic implementation. Normative integration
into `LANGUAGE.md` is still required before the draft is ready for review.

## Non-trapping partial comparison

`const Float = import "blot:float"` provides `PartialOrdering` and extended `F64`
and `F32` namespaces. Each namespace retains its original members and adds:

- `partial_cmp : F64 -> F64 -> PartialOrdering` (respectively `F32`).
- `cmp_exn`, an explicitly named alias for the existing trapping `cmp` operation.

`PartialOrdering` is `#Equal | #Greater | #Less | #Unordered`. Either NaN operand
produces `#Unordered`; equal signed zeroes and equal infinities produce `#Equal`.
Other operands use the existing precision-specific ordering. This is a total API
for reporting a partial order, not a total order on floating-point values.

The implementation tests NaN before invoking the trapping primitive. A closed
integer intermediate avoids the backend's current nested dynamic-sum widening
restriction. Internal codes are not a public API. Host callers use the emitted
ABI manifest rather than assuming constructor tags. An exported comparator should
carry an explicit closed signature, as in `src/node/language_review.test.ts`.

## Pipeline adapters

`open import "blot:pipeline"` exports configuration-first, data-last adapters:

```blot
values
  |> map_with normalize
  |> filter_with valid
  |> fold_with step initial
```

`map_with` takes a transformation and then an array. `filter_with` takes a Boolean
predicate and then an array. `fold_with` takes a tuple-argument step, an initial
state, and then an array. The final data argument retains the underlying
library's borrowing behavior. These initial adapters have pure callback
signatures; effect-polymorphic variants are not claimed by this change.

The tuple-oriented base APIs remain available. These adapters introduce no
special partial-application or pipeline saturation rule.

## Validation

`node --import tsx --test src/node/language_review.test.ts` passes 12 tests against
the Rust/Wasm compiler artifact from main commit
`bbd33c00275189a45d22ad6c23cb231567d0d583` plus these ordinary source modules.
Tests include runtime F32/F64 parameters, NaN in either position, infinities,
signed zero, F32 rounding, trapping aliases, evaluator/Wasm agreement, borrowed
pipeline inputs, Text mapping, empty arrays, and full-width i64 decimal values.

The oversized-computed-Int test records an existing rejection, not an implemented
arbitrary-precision language extension. Core operator inference, predicate
certificates, numeric lexical extensions, and native expression holes are not
implemented by these library changes.
