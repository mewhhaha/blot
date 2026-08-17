# Owned-region benchmark

`pnpm benchmark:owned-regions` compares the same iterative quicksort control
flow in two representations:

- `persistent` passes an immutable array through every swap, so both element
  writes call `store_write_persistent`; and
- `owned-region` acquires one `Slice`, then every element write calls
  `store_write_owned` until `freeze`.

Both variants use the same persistent range worklist. Inputs are deterministic
shuffled permutations with one host-supplied element so staging cannot sort the
array at compile time. The benchmark checks the sorted first, middle, and last
sentinels, instruments gpupaper's Store runtime imports for one execution, and
reports the median of 11 executions in fresh Wasm instances after three warmups.
Compilation time excludes compiler construction and a prelude warmup.

## Cost model

Let `W(n)` be the number of element writes performed by quicksort. The shared
comparison and partition work is average `O(n log n)` and worst-case `O(n^2)`.
The persistent version performs `W(n)` Store copies of length `n`, for
`O(n W(n))` copied elements. The owned version performs zero element-Store
copies after acquisition and `W(n)` constant-time destructive writes. Both
retain `O(n)` persistent worklist growth, which is reported rather than hidden.

Thus the expected element-copy work changes from average `O(n^2 log n)` and
worst-case `O(n^3)` to zero after acquisition. This does not change quicksort's
comparison bound; it removes the immutable Store-copy multiplier.

## Local result

Measured 2026-08-17 on Node 26.7.0, Linux x86-64, AMD Ryzen 7 3800X:

|   n | persistent median | owned median | speedup | persistent element writes | owned element writes | persistent Wasm | owned Wasm |
| --: | ----------------: | -----------: | ------: | ------------------------: | -------------------: | --------------: | ---------: |
|  16 |         229.56 us |    154.52 us |   1.49x |             46 persistent |             46 owned |        11,089 B |    7,981 B |
|  32 |         442.19 us |    394.81 us |   1.12x |            176 persistent |            176 owned |        12,074 B |    8,483 B |
|  64 |       1,130.18 us |    642.77 us |   1.76x |            396 persistent |            396 owned |        13,998 B |    9,473 B |
| 128 |       2,375.39 us |  1,084.70 us |   2.19x |            832 persistent |            832 owned |        18,097 B |   11,525 B |

Across these inputs the owned version eliminates every persistent element write,
runs 1.12-2.19x faster, and emits 28-36% fewer Wasm bytes. Absolute timings are
machine-local; the instrumented Store-call classification is the semantic
regression contract.
