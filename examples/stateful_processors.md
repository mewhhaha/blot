# Stateful stream processors

`stateful_processors.blot` builds a small reusable processor abstraction for
pipelines that carry state and may suppress individual inputs. A processor
relates three types:

```blot
Processor (State, Input, Output)
```

Its `step` consumes one `Input`, updates `State`, and returns `Option Output`.
The descriptor returned by `make` also carries `state_type`, `input_type`, and
`output_type` as compile-time values. That lets `compose` and `run` derive exact
signatures from a concrete processor instead of asking callers to repeat its
type arguments.

The concrete pipeline begins with raw integer readings. `distinct` removes
consecutive duplicates and emits `Distinct`; `large_jumps` consumes `Distinct`
values and emits a `Jump` only when the absolute change is at least five.
`compose` shares `Distinct` as the exact intermediate carrier and pairs the two
independent state types. When the upstream stage returns `#None`, the downstream
stage is not executed, so a suppressed duplicate cannot accidentally advance the
jump detector.

This is different from `Reducer`: a reducer always folds every input into one
hidden accumulator and produces one final result, while a processor can emit
zero or one value per input and can be composed into another stateful processor.
It is also different from the checkout transition example: processor state
persists across an input stream rather than representing one one-shot protocol
state.

## Compiler-enforced relationships

The compiler checks that `make`'s initial state and step agree with the declared
state/input/output type values; `compose` requires the left output to flow into
the right input; `run ProcessorValue` accepts only
`[ProcessorValue.input_type]`; and its result keeps `ProcessorValue.state_type`
and `[ProcessorValue.output_type]`. The two rejection fixtures exercise
stage-adjacency and run-input mismatches.

The compiler does **not** prove semantic processor laws. In particular, the type
alone does not prove that a stage updates its state only when it should, that a
suppression policy is idempotent, or that two alternative pipeline associations
have identical behavior. Those remain implementation behavior and are exercised
by the executable goldens.

The descriptor fields are compile-time metadata, not a dynamic registry. Runtime
state remains the ordinary `initial` value plus the values returned by `step`.

## Run

```sh
pnpm blot check examples/stateful_processors.blot
pnpm blot run examples/stateful_processors.blot
pnpm blot build examples/stateful_processors.blot
pnpm blot lint --check examples/lib/stream_processor.blot examples/stateful_processors.blot
node --import tsx --test src/node/stateful_processors.test.ts
node scripts/check_abstractions.mjs
```

## Covered edge cases

The main stream `[10, 10, 12, 20, 20, 15, 16]` demonstrates duplicate
suppression and emits exactly the `12 -> 20` and `20 -> 15` jumps. The final
paired state is `(16, 16)`, showing that the last small distinct change still
updates the detector baseline even though it emits no alert.

The same `distinct` stage runs independently over `[2, 2, 3]`, and the same
downstream stage runs independently over `[1, 10]`, demonstrating reuse outside
the composed pipeline. A duplicate-only stream emits nothing but establishes one
baseline in each stage. The empty stream emits nothing and preserves both
initial `#None` states. Those two cases are important because the result still
has `[Jump]`, not an inferred empty-element type.

## Design tradeoff and current inference pressure

The natural first implementation gave `run` a fully rank-polymorphic signature
over `State`, `Input`, and `Output` and initialized its output array with
`Array.empty`. The checker currently leaves the no-emission branch at `[⊥]`,
then rejects the implementation because `[⊥]` does not flow into the expected
`[Output]`. `src/node/fixtures/stream_processor_rank_polymorphic_run.blot`
records that exact pressure case.

The committed API does not weaken the result or insert an unchecked escape
hatch. Instead it uses a Blot-native staged descriptor:
`ProcessorValue.output_type` is an ordinary compile-time type value, so
`@satisfies Array.empty [ProcessorValue.output_type]` gives the accumulator its
exact element type. The tradeoff is that processors are created through `make`
and carry explicit type metadata. This is useful metadata for composition and
keeps call sites concise, but it is slightly more structure than the direct
rank-polymorphic record alone.
