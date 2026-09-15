# Ownership-preserving collectors

This example factors a concrete stream-ingestion problem into a reusable
`Collector (Input, Output)` API. A collector receives one input together with an
owned output buffer and decides whether to continue or stop. `run` allocates the
fresh buffer, threads it through the callback, and reports whether the input was
exhausted or the collector stopped early.

The concrete collector accepts `#Sample Score | #End Text`, where
`Score = 0..100`. It collects scores until `#End`. `contramap` then lifts that
same collector to a wider transport envelope without changing its output type or
its ownership behavior.

## Abstraction and type-system design

`Collector (Input, Output)` is an ordinary function type:

```blot
([Output], Input) -> (#Continue [Output] | #Stop [Output])
```

The shared `Output` rules out a callback that changes the buffer element type.
The `contramap` signature quantifies `Outer`, `Inner`, and `Output` separately,
then shares `Inner` between the projection result and the underlying collector.
A projection that returns the wrong carrier therefore fails by ordinary type
checking. The concrete `Score` refinement additionally rejects samples outside
`0..100` before execution.

Ownership is deliberately **not** part of that type. `run` hands the buffer to
its callback with `?values`, and every callback result pattern binds the returned
buffer with `?next`. Blot's separate higher-order ownership analysis records that
relationship and rejects callbacks that replace or drop the handed-off Store.
The `owned_collector_drops_buffer.blot` fixture checks that guarantee. This is a
compiler-enforced ownership property, not an assumption inferred from equal
array types.

`run` is curried because `run collector` is useful on its own: it produces a
reusable runner for one collection policy. The recursive worker then consumes
inputs in order and returns immediately on `#Stop`. The source semantics remain
persistent; the example makes no allocation-count or speed claim from Store
authority alone.

## Run it

```bash
pnpm blot check examples/ownership_preserving_collectors.blot
pnpm blot run examples/ownership_preserving_collectors.blot
pnpm blot build examples/ownership_preserving_collectors.blot
```

The focused regression is:

```bash
node --import tsx --test src/node/ownership_preserving_collectors.test.ts
```

## Expected behavior and edge cases

The lifted envelope run sees scores `10` and `20`, then stops at `#End`; the
trailing `99` is never offered to the collector. A stream containing only the
legal endpoints `0` and `100` is exhausted normally. An immediate `#End` stops
with an empty buffer, and an explicitly typed empty input is exhausted with an
empty buffer. The Unicode source label `"münchen"` confirms that unrelated
transport fields do not affect the projected command.

Three rejection fixtures cover distinct guarantees: dropping the owned buffer
fails higher-order ownership checking; projecting `Text` into a collector that
requires `Command` fails ordinary type checking; and `#Sample 101` fails the
`0..100` refinement.

## Known pressure point

A richer control shape would naturally carry stop metadata alongside the buffer,
for example `#Stop ([Output], Reason)`. The current higher-order ownership matcher
rejects that shape even when the callback returns the exact same Store authority.
The supported API therefore keeps `Step` to `#Continue [Output] | #Stop [Output]`
and leaves domain metadata in domain data rather than weakening ownership.
`src/node/fixtures/owned_collector_stop_payload_pathology.blot` records the
exact current refusal as a focused pathology reproduction. It is not listed as a
supported program or an intentional language rejection.
