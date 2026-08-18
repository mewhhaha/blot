# Owned-region benchmark

`pnpm benchmark:owned-regions` compares the same iterative quicksort control
flow in two representations:

| lane | element update | question |
| --- | --- | --- |
| `persistent` | `Array.set` swaps | What do persistent element updates cost? |
| `owned-region` | `Slice.partition_range` | What changes when unique authority permits in-place writes? |

Both lanes have equivalent partitioning and persistent range-worklist structure,
so their comparison isolates persistent Store copies from owned Store writes.

Both lanes sort the same deterministic shuffled permutation. Its first element is
host-supplied so staging cannot precompute the result. The benchmark checks a
full order-sensitive checksum, instruments gpupaper's Store imports for one
execution, and reports the median of 11 executions in fresh Wasm instances after
three warmups. Compilation time excludes compiler construction and a prelude
warmup.

## Theory and expected costs

Let `C(n)` be quicksort's comparisons and `W(n)` its element writes. Both lanes
retain average `O(n log n)` and worst-case `O(n^2)` comparison work.

The persistent-update lane performs `W(n)` logical Store writes. The gpupaper
runtime implements each persistent write by copying the entire backing Store, so
the element-copy term is `O(n W(n))`: average `O(n^2 log n)` and worst-case
`O(n^3)` for this representation.

The owned-region lane acquires one `Slice`, consumes and returns its authority,
and freezes it once sorting ends. Its `W(n)` element writes mutate the same
uniquely owned Store, making the write term `O(W(n))` with zero persistent
element-Store copies after acquisition. It still uses a persistent range
worklist, whose growth calls are reported rather than hidden.

## What the measurements establish

- Store import call counts classify the dynamic writes and growth operations.
- HIR write-site counts verify that the compiled paths selected persistent or
  owned Store updates before Wasm emission.
- Wasm byte size compares the emitted artifacts for these exact programs.
- Timings are a local end-to-end regression signal, not a portable native-code
  performance claim. This benchmark uses the JavaScript gpupaper Store runtime;
  the Rust backend's owned path instead writes directly to reused linear memory.

The semantic regression contract is that the owned element path performs owned
writes and no persistent writes. Timing ratios may vary with the machine and
runtime.

## Local result

Measured 2026-08-18 on Node 24.19.0 and Linux x86-64:

| n | persistent median | owned median | speedup | writes in each lane | persistent Wasm | owned Wasm | Wasm reduction |
| --: | --: | --: | --: | --: | --: | --: | --: |
| 16 | 233.08 us | 140.08 us | 1.66x | 46 | 11,018 B | 8,255 B | 25.1% |
| 32 | 525.98 us | 304.61 us | 1.73x | 176 | 11,998 B | 8,763 B | 27.0% |
| 64 | 823.96 us | 575.46 us | 1.43x | 396 | 13,922 B | 9,754 B | 29.9% |
| 128 | 1,871.05 us | 1,115.82 us | 1.68x | 832 | 18,017 B | 11,802 B | 34.5% |

For every size, the persistent artifact imported only
`store_write_persistent` and the owned artifact imported only
`store_write_owned`. The HIR contained four sites of the corresponding kind in
each artifact. At runtime, the write counts matched exactly while the owned lane
executed zero persistent writes. Two repeat runs preserved those structural
results; local timing ratios varied, as expected for short fresh-instance runs.

## Functional readability baseline

`examples/quicksort.blot` remains the deliberately allocation-heavy surface
comparison using `Array.uncons`, stable `Array.partition`, recursion, and `<>`.
It is not included as a runtime timing lane yet. Making its input host-dynamic
currently reaches dynamic `@array.take` through `Array.uncons`, and the checked
Runtime-HIR compiler rejects that primitive before Wasm emission. A staged,
constant-input artifact would only measure returning a precomputed result and
would be misleading.

Once dynamic extraction and the recursive functional path are admitted by
Runtime HIR, that formulation should become a third end-to-end lane. It will be
a readability-versus-cost comparison, not an ownership-isolation comparison,
because it also changes control flow and allocation structure.
