# Owned-region benchmark

`pnpm benchmark:owned-regions` compares three quicksort formulations:

| lane | element update | question |
| --- | --- | --- |
| `structural-persistent` | `uncons`, stable `partition`, and `<>` | What does the simplest Haskell-shaped program cost? |
| `persistent` | `Array.set` swaps | What do persistent element updates cost? |
| `owned-region` | `Slice.partition_range` | What changes when unique authority permits in-place writes? |

The last two lanes have equivalent iterative control flow and persistent
range-worklist structure, so their comparison isolates persistent Store copies
from owned Store writes. The structural lane deliberately changes the algorithm
and is a readability-versus-cost comparison, not part of that isolation claim.

Both lanes sort the same deterministic shuffled permutation. Its first element is
host-supplied so staging cannot precompute the result. The benchmark checks a
full order-sensitive checksum, instruments gpupaper's Store imports for one
execution, and reports the median of 11 executions in fresh Wasm instances after
three warmups. Compilation time excludes compiler construction and a prelude
warmup.

## Theory and expected costs

Let `C(n)` be quicksort's comparisons and `W(n)` its element writes. Both lanes
retain average `O(n log n)` and worst-case `O(n^2)` comparison work.

The structural lane has the familiar recurrence
`T(n) = T(k) + T(n-k-1) + decomposition + partition + joins`. With contiguous
Stores, `uncons` copies its remainder. Stable partition and `<>` grow persistent
Stores; the JavaScript runtime copies the existing backing Store at each growth.
That makes balanced recursive levels approximately `O(n^2)` in element-copy
work and the maximally unbalanced case `O(n^3)`. This is the price of the
shortest pure formulation under the current representation, not a semantic
requirement of `uncons`, partition, recursion, or the monoid operator.

The iterative persistent-update lane performs `W(n)` logical Store writes. The gpupaper
runtime implements each persistent write by copying the entire backing Store, so
the element-copy term is `O(n W(n))`: average `O(n^2 log n)` and worst-case
`O(n^3)` for this representation.

The owned-region lane acquires one `Slice`, consumes and returns its authority,
and freezes it once sorting ends. Its `W(n)` element writes mutate the same
uniquely owned Store, making the write term `O(W(n))` with zero persistent
element-Store copies after acquisition. It still uses a persistent range
worklist, whose growth calls are reported rather than hidden.

## What the measurements establish

- Store import call counts classify dynamic writes and growth operations.
- HIR mutation-site counts verify that structural quicksort uses only
  persistent growth, iterative persistent quicksort uses persistent writes,
  and the owned element path uses only owned writes.
- The structural lane additionally asserts a residual `call.direct` and the
  absence of quicksort, partition, uncons, take, or split Runtime-HIR opcodes.
- Wasm byte size compares the emitted artifacts for these exact programs.
- Timings are a local end-to-end regression signal, not a portable native-code
  performance claim. This benchmark uses the JavaScript gpupaper Store runtime;
  the Rust backend's owned path instead writes directly to reused linear memory.

The semantic regression contract is that the owned element path performs owned
writes and no persistent writes. Timing ratios may vary with the machine and
runtime.

## Local result

Measured 2026-08-18 on Node 24.19.0 and Linux x86-64:

| n | structural median | iterative persistent | owned median | structural Wasm | persistent Wasm | owned Wasm |
| --: | --: | --: | --: | --: | --: | --: |
| 16 | 179.14 us | 191.46 us | 144.34 us | 7,003 B | 11,018 B | 8,255 B |
| 32 | 386.97 us | 575.65 us | 536.55 us | 7,456 B | 11,998 B | 8,763 B |
| 64 | 968.85 us | 1,104.96 us | 597.59 us | 8,436 B | 13,922 B | 9,754 B |
| 128 | 2,001.58 us | 1,883.76 us | 1,203.71 us | 10,484 B | 18,017 B | 11,802 B |

For every size, structural quicksort imported only `store_grow_persistent` and
executed no Store writes; the iterative persistent artifact imported only
`store_write_persistent`; and the owned artifact imported only
`store_write_owned` for element mutation. At `n = 128`, the structural lane
created 898 Stores and made 3,152 persistent growth calls, while the iterative
lanes made 832 element writes. The owned lane made all 832 as `owned-reuse` and
zero as persistent writes. Repeat runs preserved those structural results;
local timing order between the two persistent formulations varied, as expected
for short fresh-instance runs, while the owned lane remained fastest here.

## Functional readability baseline

`examples/quicksort.blot` is now the executable source for the third lane:
`Array.uncons` decomposes one element, `Array.partition` performs the stable
classification, `<>` is ordinary array-monoid append, and non-tail recursion
becomes a residual `call.direct`. Dynamic `@array.take` and `@array.split`
compile to generic Store length/read/grow operations and control flow in both
compiler implementations. No collection-algorithm opcode crosses Runtime HIR.
