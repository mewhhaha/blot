# Language review: library extensions

These modules are ordinary Blot source. They add no primitives, grammar,
implicit imports, runtime reflection, or alternate semantic implementation. The
normative contracts and their restrictions are specified in `LANGUAGE.md`
section 14.1. The compiler research below remains outside this bounded change.

## Floating-point partial comparison

`const Float = import "blot:float"` provides `PartialOrdering` and extended
`F64` and `F32` namespaces. Each adds `partial_cmp` and `cmp_exn`.

`partial_cmp` takes two values of its precision and returns
`#Equal | #Greater | #Less | #Unordered`. Either NaN produces `#Unordered`.
Equal signed zeroes and equal infinities produce `#Equal`. This is a total API
reporting a partial order, not a total ordering of floating-point values.
`cmp_exn` explicitly names the existing NaN-trapping comparison.

The implementation checks NaN before the trapping primitive. A closed integer
intermediate avoids the current backend's nested dynamic-sum restriction.
Internal codes are not a public API. Host callers use the emitted ABI manifest;
exported comparators should carry a closed signature.

## Pipelines

`open import "blot:pipeline"` provides configuration-first, data-last
`map_with`, `filter_with`, and `fold_with`:

```blot
values
  |> map_with normalize
  |> filter_with valid
  |> fold_with step initial
```

The final array argument retains the base library's borrowing behavior. These
initial adapters have pure callback signatures. Effect-polymorphic variants are
not claimed. The original tuple-taking APIs remain available; no special
application or pipeline saturation rule was introduced.

## Restricted derivation

`const Derive = import "blot:derive"` exposes `fields` and `integer_record`.
`fields` accepts structural schemas containing integer/text scalars and returns
the schema with attached `.fields` evidence. Each descriptor has a `.type` and a
checked `.read` operation. Arrays, functions, opaque nominal values, and other
unsupported fields are refused, not given unsafe getters. The enclosing schema
and selected field type remain checked at each use.

The getter takes a deferred argument, keeping static field-name evidence staged.
It is not an unrestricted first-class runtime projection. This restriction
avoids a reproduced backend specialization problem described in
`experiments/language-review/README.md`; the underlying cache is not fixed.

`integer_record` accepts nonempty integer-only record schemas and attaches an
`.encode` operation. It is a restricted product encoder, not JSON, not a sum
codec, and not a decoder. Each field is encoded as `N:name=value;`, where `N` is
the Unicode-scalar length of the field name. Field order follows the reflected
schema's declaration order. Runtime code uses ordinary projections and text
operations, not runtime reflection.

```blot
const Codec = Derive.integer_record { .count = Int; .code = Int; }
let encode :: Int -> Text
let encode = fn count => Codec.encode { .count = count; .code = 7; }
```

Ownership-aware consuming extraction, rebuilding evidence, sums, private
construction authority, and a general derivation certificate are still research
work. The tests include an extra owned field under width subtyping so a
successful scalar getter cannot silently discard another obligation.

## Editor and completion experiments

Control-flow hovers show the nearest `do` or module result scope, the nearest
loop for `break`, and the loop accumulator emitted by surface lowering.
Accumulator discovery uses lowered syntax rather than duplicating shadowing
rules. Highlight ranges are available internally, but LSP document-highlight
integration is not part of this change.

`experiments/language-review/completions.ts` recognizes experimental
`@hole "name"` markers with Baba, substitutes bounded single-line expressions,
and validates the complete result with the real Rust/Wasm checker. It does not
implement native expression holes or expose all local obligations. Unresolved
markers remain production errors. Candidate checking is not an untrusted-code
sandbox and may execute ordinary compile-time code.

## Validation

The implementation tracker records commands and results. Tests cover dynamic
F32/F64 parameters, NaN, infinities, signed zero, F32 rounding, trapping
aliases, evaluator/Wasm agreement, borrowed pipeline inputs, scalar evidence,
negative ownership cases, canonical Text results, scope hovers, and completion
rejection. Core overload coherence, predicate summaries, numeric lexical
extensions, and native obligation-aware holes are not completed features.
