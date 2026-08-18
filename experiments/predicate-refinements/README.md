# Predicate-refinement experiment

This experiment compares two equivalent programs:

```blot
const Byte = range (0, 255)
```

and:

```blot
const Byte = refine (Int, fn value => value >= 0 && value <= 255)
```

The theory predicts a small compile-time normalization cost and no resulting
code cost. `refine` produces the same canonical `0..255` value before the type
is bridged into inference; predicates are erased before Runtime HIR.

Run:

```sh
pnpm benchmark:predicate-refinements
```

The benchmark alternates ordering across nine fresh compiler sessions, reports
median end-to-end check time, builds both programs, and then verifies:

- the Runtime HIR operation histograms are identical;
- the emitted WebAssembly bytes and SHA-256 digests are identical;
- both exports return `120`; and
- steady-state direct WebAssembly-call medians remain observational evidence,
  not a claim that sub-nanosecond differences between identical bytes are real.

The benchmark fails rather than merely reporting if either lowering or emitted
bytes differ. This makes the zero-runtime-overhead claim a regression gate.

## Local evidence

Node 24.19.0 on 2026-08-18, nine alternating samples:

| measurement | canonical range | predicate | result |
| --- | ---: | ---: | --- |
| median check | 9.79 ms | 10.96 ms | 1.12x compile-time cost |
| emitted Wasm | 962 bytes | 962 bytes | identical |
| Wasm SHA-256 | `37172b2f…a3a8f8` | `37172b2f…a3a8f8` | identical |
| Runtime HIR | one `constant` | one `constant` | identical |
| direct call median | 8.26 ns | 8.70 ns | identical code; timing noise |

The predicate path paid about 1.17 ms in this small check-heavy fixture. The
resulting artifact had zero byte, operation, or semantic overhead. Direct-call
timings are included to detect gross regressions; because the Wasm hashes are
identical, their difference is scheduler and timer noise rather than a generated
code difference.
