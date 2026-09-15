# Typed service adapters

A service often has a small domain-facing function while transport and API layers
wrap both its input and its output. `lib/service_adapter.blot` factors that
boundary into one reusable value:

```blot
Adapter (OuterInput, InnerInput, InnerOutput, OuterOutput)
```

An adapter contains a contravariant request transformation
`OuterInput -> InnerInput` and a covariant response transformation
`InnerOutput -> OuterOutput`. `compose` shares both middle carriers, so two
layers compose only when the first layer's inner request and response types are
exactly usable by the second. `adapt` applies the resulting boundary to a
service while a signature-local `..e` preserves every effect performed by that
service.

The executable builds two layers: wire-to-API and API-to-core. Their composition
wraps both a pure core service and a `Health`-effectful core service without
changing the adapter. The effectful call is handled only after adaptation,
showing that the boundary did not hide the service effect.

## What the compiler enforces

- request and response carriers must line up at every composition boundary;
- the adapted service must accept the adapter's exact inner request carrier and
  return its exact inner response carrier;
- effects performed by the wrapped service remain in the adapted function's
  effect row and cannot be erased by a pure signature;
- `Port = 1..65535` is preserved through both request layers, so the maximum
  legal port remains refined at the core service boundary.

The adapter does **not** prove semantic laws such as round-trip identity or that
a response encoding is the inverse of a request decoding. Those are ordinary
library/application laws rather than facts represented by this type.

The request/response transformations are deliberately pure. Blot's open effect
row tail is scoped to a signature header, not a first-class type value, so a
type-valued `Adapter` constructor cannot itself store transformations quantified
over arbitrary effect rows. `adapt` can still preserve the wrapped service's row
because the relationship appears directly in its function signature.

## Run it

With the matching Rust/Wasm compiler artifact installed:

```sh
pnpm blot check examples/typed_service_adapters.blot
pnpm blot run examples/typed_service_adapters.blot
pnpm blot lint --check \
  examples/lib/service_adapter.blot \
  examples/typed_service_adapters.blot
pnpm blot build examples/typed_service_adapters.blot
node --import tsx --test src/node/typed_service_adapters.test.ts
```

The recorded result covers ordinary and maximum refined ports, Unicode service
and trace text, two-layer composition, identity adaptation, a pure service, and
an effectful service. Focused rejection fixtures cover a mismatched composition
middle, a handler with the wrong inner request carrier, and attempted effect
erasure.
