# Generated-code performance

`deno task experiment:generated-code` compares WebAssembly emitted by the
production Blot compiler with equivalent Rust compiled for
`wasm32-unknown-unknown`. Both artifacts execute in the same Deno V8 process.
Compilation, validation, instantiation, warmup, and observation validation are
outside the clock.

Every timed row first checks both artifacts against an independent TypeScript
result. The harness takes eleven alternating samples, reports the median with
p10 and p90, and calibrates each implementation toward a 40 ms sample. Scalar
host-input workloads cycle through 64 values. Scaling workloads call the same
first-order export with one of four runtime sizes, so their artifact does not
grow with the input.

Rust is built with:

```text
rustc --edition=2024 --target=wasm32-unknown-unknown -O \
  -Cpanic=abort -Cstrip=symbols --crate-type=cdylib
```

## 2026-08-06 observation

This run used an AMD Ryzen 7 7800X3D on Linux 7.1.5, Deno 2.9.4 with V8
15.0.245.2, and rustc 1.96.0-nightly. The Blot compiler artifact SHA-256 was
`9535d8fd57bfce8dbdc888ef77703c48d05aa48e00d16cdd7f955e65b0a1e95f`.

| Workload       | Pressure                           | Blot ns/call | Rust ns/call | Blot / Rust |
| -------------- | ---------------------------------- | -----------: | -----------: | ----------: |
| host roundtrip | Wasm call and scalar host import   |         15.8 |         17.2 |       0.92× |
| scalar mix     | 16 dependent checked integer steps |         72.2 |         60.3 |       1.20× |
| branch mix     | seven-leaf dynamic conditional     |         23.4 |         18.6 |       1.26× |
| function chain | 16 source-level function calls     |         70.1 |         56.8 |       1.23× |
| fixed array    | eight values, destructure, release |         22.7 |         50.9 |       0.45× |

The Runtime-HIR forwarding-block simplification reduced the branch artifact from
3,353 to 3,253 bytes. On this run the branch ratio also moved from the previous
1.50× observation to 1.26×. The size change is deterministic; the time change is
an observation, not proof that all of it came from the simplification.

## Scaling

| Family / n         |      16 |      64 |     256 |   1,024 |
| ------------------ | ------: | ------: | ------: | ------: |
| tail recursion     |  212 ns |  692 ns | 2.78 µs | 11.1 µs |
| Rust counterpart   | 13.9 ns | 12.9 ns | 15.5 ns | 14.1 ns |
| range fold         |  193 ns |  748 ns | 3.08 µs | 11.6 µs |
| Rust counterpart   | 11.4 ns | 12.4 ns | 12.2 ns | 12.5 ns |
| surface iteration  |  136 ns |  510 ns | 2.45 µs | 8.87 µs |
| Rust counterpart   | 12.7 ns | 13.9 ns | 14.4 ns | 15.8 ns |
| array construction |  247 ns | 1.14 µs | 6.65 µs | 75.1 µs |
| Rust counterpart   | 63.5 ns |  132 ns |  377 ns | 1.33 µs |
| retained growth    |  351 ns | 1.43 µs | 8.05 µs | 74.7 µs |
| Rust counterpart   |  418 ns | 2.51 µs | 14.2 µs | 83.7 µs |

The first three families expose the important pathological case. Blot emits
linear work. LLVM recognizes the Rust accumulators and range sums and reduces
them to constant-work arithmetic. Surface `for` is about 20–30% faster than the
generic range fold here, but both retain the same linear asymptote. Blot needs
tail-recursion-to-loop recovery and a comparable predictable fold
simplification; faster call emission alone cannot close this gap.

Dynamic array construction currently uses persistent Store growth. Each push
allocates and copies the existing payload, so the curve trends quadratic while
Rust's `Vec` grows geometrically. The retained-growth counterpart deliberately
clones the Rust `Vec` before every push because the old version remains
observable. Under those equal immutable semantics Blot is between 0.57× and
0.89× Rust in the larger three cases. This distinction is the ownership theory
in executable form: an owned-reuse certificate changes the asymptotic cost;
without one, copying is required for correctness.

## Artifact size

Marginal bytes subtract a boundary-matched baseline: host roundtrip for the
nullary host-input artifacts and unary identity for first-order function
exports. The subtraction isolates workload growth without pretending that the
ABI shell disappears from the shipped file.

| Artifact           | Blot bytes | Blot marginal | Rust bytes | Rust marginal |
| ------------------ | ---------: | ------------: | ---------: | ------------: |
| host roundtrip     |      1,901 |             0 |        155 |             0 |
| scalar mix         |      3,994 |         2,093 |        218 |            63 |
| branch mix         |      3,253 |         1,352 |        329 |           174 |
| function chain     |      3,998 |         2,097 |        277 |           122 |
| fixed array        |      2,322 |           421 |     13,564 |        13,409 |
| unary identity     |      1,125 |             0 |        122 |             0 |
| tail recursion     |      1,564 |           439 |        344 |           222 |
| range fold         |      1,554 |           429 |        364 |           242 |
| surface iteration  |      1,596 |           471 |        338 |           216 |
| array construction |      1,649 |           524 |     13,392 |        13,270 |
| retained growth    |      1,845 |           720 |     13,571 |        13,449 |

Small non-allocating Blot artifacts pay roughly a 1.1 KB ABI/runtime shell.
Rust's allocator makes its Store counterparts much larger, while its scalar
artifacts remain substantially smaller.

## Remaining capability probe

Residual recursion, captured runtime bounds, direct calls, explicitly signed
first-order exports, host-driven module loops, and surface `for` over
`Iter.range` now compile through the Rust production path. The capability probe
reported no unsupported paths. The engine case study also reaches ABI planning;
it is then refused for its declared `F32x4` host boundary, which is the
specified ABI 1 SIMD restriction rather than a residual-lowering gap.

The complete machine-readable report includes source and artifact hashes,
artifact sizes and boundary-relative marginal sizes, flags, calibrated
invocation counts, percentile ranges, and capability diagnostics. Re-run it
after a backend change instead of treating one machine's observations as a
release threshold.
