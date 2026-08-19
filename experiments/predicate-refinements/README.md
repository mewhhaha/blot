# Predicate-refinement experiment

This experiment compares two pairs of equivalent programs. The first pair spells
an integer type canonically:

```blot
const Byte = range (0, 255)
```

and:

```blot
const Byte = refine (Int, fn value => value >= 0 && value <= 255)
```

The second pair returns the same record field directly or after checking its
inferred type with composed source predicates. That path also compares two
alpha-equivalent `@forall` types and instantiates one before reflecting its
arrow shape.

The theory predicts at most a small compile-time normalization/observation cost
and no resulting code cost. `refine` produces the same canonical `0..255` value
before the type is bridged into inference; reflection, exact equality,
instantiation, and predicate assertions are also erased before Runtime HIR.

Run:

```sh
pnpm benchmark:predicate-refinements
```

The benchmark alternates ordering across nine fresh compiler sessions, reports
median end-to-end check time, builds both pairs, and then verifies:

- the Runtime HIR operation histograms are identical;
- the emitted WebAssembly bytes and SHA-256 digests are identical;
- both exports return `120`; and
- steady-state direct WebAssembly-call medians remain observational evidence,
  not a claim that sub-nanosecond differences between identical bytes are real.

The benchmark fails rather than merely reporting if either lowering or emitted
bytes differ. This makes the zero-runtime-overhead claim a regression gate.

## Local evidence

Node 24.19.0 on 2026-08-19, nine alternating samples:

| measurement        |   canonical range |         predicate | result                       |
| ------------------ | ----------------: | ----------------: | ---------------------------- |
| median check       |          12.25 ms |          11.94 ms | 0.97x; within run noise      |
| emitted Wasm       |         962 bytes |         962 bytes | identical                    |
| Wasm SHA-256       | `8426f881…8b3e6a` | `8426f881…8b3e6a` | identical                    |
| Runtime HIR        |    one `constant` |    one `constant` | identical                    |
| direct call median |           9.41 ns |           9.49 ns | identical code; timing noise |

| advanced type observation |   direct baseline |        predicates | result                       |
| ------------------------- | ----------------: | ----------------: | ---------------------------- |
| median check              |          10.96 ms |          10.53 ms | 0.96x; within run noise      |
| emitted Wasm              |         962 bytes |         962 bytes | identical                    |
| Wasm SHA-256              | `8426f881…8b3e6a` | `8426f881…8b3e6a` | identical                    |
| Runtime HIR               |    one `constant` |    one `constant` | identical                    |
| direct call median        |           8.94 ns |          12.14 ns | identical code; timing noise |

Both compile-time comparisons reversed ordering in this run and remain within
the noise floor of these small fixtures. Both resulting artifacts had zero byte,
operation, or semantic overhead. Direct-call timings are included to detect
gross regressions; because each pair's Wasm hashes are identical, their
differences are scheduler and timer noise rather than generated-code
differences.
