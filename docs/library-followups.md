# Concrete library follow-ups

The September triage made three additions conditional on a useful contract. This
implementation exercises those contracts without extending the language's
primitive or declaration vocabulary.

## Written module inputs

[The checked module](../examples/lib/checked_module_input.blot) binds its input
normally, opens the prelude explicitly, and constrains the input with a separate
`Settings` signature. [Its caller](../examples/module_input_contract.blot)
passes an ordinary record. A wrongly typed `count` is rejected by the existing
checker. This supplies a written upper bound today. Another module-header
annotation form would duplicate that mechanism and complicate which names exist
before imports; leave the header unchanged.

## Enum and product codecs

[The command codec](../examples/lib/command_codec.blot) encodes `#Reset` and
`#Move { .x; .y; }` and decodes complete commands through `blot:parse`.
[The executable example](../examples/command_codec.blot) covers round trips,
Unicode rejection and overflowing coordinates. The enum and record are ordinary
source values. No reflection primitive, implicit instance lookup, or ownership
exception is needed for this codec. Generic derivation remains restricted to its
documented checked field/constructor fragment; a private seal or owned field
does not become public or duplicable merely because it has a codec.

## Pure float presentation

[`blot:float`](../src/prelude/float.blot) now provides `F64.to_text` and
`F32.to_text` as pure source functions. Each finds the shortest decimal that
rounds back in its own precision; ties and display notation are specified in
[the language contract](../LANGUAGE.md#141-optional-source-libraries). Binary32
does not expose the longer binary64 expansion of a widened value. Signed zero
and nonfinite values have explicit spellings. No host effect or new primitive is
needed.

[The implementation](../src/prelude/float_format.blot) uses an exact rounding
interval and base-10^9 integer limbs. Powers of two normalize the significand
without raw bit operations. Nine-place decimal scaling keeps the smallest
subnormal within the evaluator's ordinary step budget. Compile-time precision
factories share the algorithm between binary32 and binary64.

[Runtime tests](../src/node/float_format.test.ts) check fixed cases, neighbors
of binary and decimal boundaries, and 512 deterministic bit patterns per
precision. Binary64 is compared with the host's shortest conversion; binary32
uses its own round-trip and minimum-significant-digit oracle. The executable
[example](../examples/float_formatting.blot) agrees in the evaluator and Wasm.
This replaces the earlier host-only prototype. Fixed-precision formatting,
locale presentation, parsing, and NaN-payload serialization remain separate
APIs.

## Inferred recursive results

[The generic search](../examples/lib/inferred_search.blot) returns `None`,
`Some T`, or its recursive call directly. It now compiles with its local
recursive result inferred. `Array.find` uses the same source structure; the
index-and-second-lookup workaround is removed.

Staging preserves the enclosing application's checked result through result
positions, including when cached expression schemes have independent generic
identities. It specializes a finite `Option` to its closed sum instead of
choosing an indirect representation from an incomplete local equation. Genuine
recursive payloads retain the existing indirect representation contract.

Tests execute 100,000 unsuccessful search steps and a match after that prefix
without stack growth. Existing collection tests cover suspended predicates,
callback order, empty input, and early exit. The evaluator and Wasm agree on
[the observable results](../examples/inferred_search.blot).

## Effectful iterator steps

A `for` now sequences the iterator's step even when its body contains only pure
accumulator updates. Ordinary declarations and `:=` still require pure values;
`use` and `return` admit effects under their existing rules. The checker now
enforces purity directly on a rebinding rather than relying on an enclosing loop
binding to constrain it. This remains ordinary recursion, cases, and bindings
produced by elaboration. There is no loop node, assignment operation, or new
effect primitive.

[Dynamic tests](../src/node/library_followups.test.ts) cover suspension, empty
input, `return`, `continue`, `break`, nested traversals, and cancellation
draining. The [handled example](../examples/effectful_iterator.blot) runs in
both executions. Borrowed callbacks with unresolved suspension behavior remain
rejected. Nested pattern names now retain their original payload variables,
which keeps early-return scalar and record representations connected to their
checked types. The movement [regression](../examples/lib/float_sweep.blot)
covers a float record accumulator with multiple exits.

## Partial function headers

Every component can be omitted independently, while `fn` remains explicit:

```blot
const first = fn (a :: Int, b) => a
const second = fn (a, b :: Int) => b
const integer = fn (a, b) -> Int => a
const mixed = fn (a :: Int, b) -> Int => a
```

Omitted components generalize with the binding. In particular,
`fn (a :: Int, b) => b` can return Text in one call and Bool in another without
joining both calls' result types. A written result also specifies a pure effect
row unless effects are explicitly admitted. Partial-header tests assert
principal result types, mismatches, formatting, and evaluator/Wasm agreement.
Statement bodies still require `do:`; this does not add bare lambdas or change
record syntax.

## Remaining boundaries

The source formatter still gives factory-result bindings explicit public
signatures. Inferred function values returned by a factory can lose parameter
precision; that deserves a separate principal-type regression before changing
closure generalization.

An owned scratch accumulator followed by another conditional push is also a
separate ownership-lowering case: the existing compiler can report duplicate
consumption after the loop. The formatter uses explicit owned array folds with
frozen final results, following the prelude's established ownership contract.
Neither issue justifies bypassing ownership checks or adding a formatting
primitive. General derivation remains limited to its documented checked
field/constructor fragment.

## Verification and cost

The rebuilt production compiler is
`c414550a570aa9ced55cb6cedc5187f196aae9aaeada144c2070ff29471a90b9`, with
checked-module certificate schema 23, host ABI 9, Runtime HIR 14 and guest
ABI 4. The Node package includes that artifact and the new source library.

The native compiler suite passes 573 tests; the Node suite passes 291. All 233
root catalog examples compile with no target refusals, all 35 focused runtime
conformance observations agree, and the 81-file regression suite passes 1,707
tests. Package, Web Worker, memory, administrative ABI, type-checking, lint and
Clippy checks pass. All 41 game compiler probes explicitly report
`supported: true`, including the five original failures. Full game verification
also passes its 44 unit tests and 33 browser scenarios. Generated Blender assets
were restored to their exact pre-test worktree bytes afterward.

The [float benchmark](../experiments/performance-pathologies/float_format.ts) on
Node 24.12.0 emitted 68,134 Wasm bytes for both exports and measured about 1.50
seconds for checking and compilation. Median canonical call times were:

| Input                    | Milliseconds per call |
| ------------------------ | --------------------: |
| F64 `0.1`                |                0.0254 |
| F64 smallest subnormal   |                0.2975 |
| F64 largest finite value |                0.7421 |
| F32 `0.1`                |                0.0081 |
| F32 smallest subnormal   |                0.0259 |

These are local observations collected alongside other verification work, not
portable thresholds. Each median covers seven batch means of 100 checked calls;
the
[benchmark boundary](../spec/COST_MODEL.md#source-float-presentation-measurements)
includes canonical adaptation and exact output assertions.

`pnpm benchmark:development --unique-edits` passes the existing latency and
memory gates with 20 distinct edits in a 5,273,553-byte, 20-unit project. Only
`unit-1` is replaced on each edit. Committed p50 is 76.65 ms, p95 is 85.23 ms,
and the maximum is 89.79 ms; maximum RSS growth is 2.71 MiB. Initial compilation
still takes 27.64 seconds for this workload. The warm-edit result does not imply
that initial compilation or every affected call graph has the same cost.
