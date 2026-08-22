# Owned-region benchmark

`pnpm benchmark:owned-regions` compares three quicksort formulations:

| lane                    | element update                         | question                                                    |
| ----------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `structural-persistent` | `uncons`, stable `partition`, and `<>` | What does the simplest Haskell-shaped program cost?         |
| `persistent`            | `Array.set` swaps                      | What do persistent element updates cost?                    |
| `owned-region`          | `Slice.swap_or_keep`                   | What changes when unique authority permits in-place writes? |

The last two lanes have equivalent smaller-first recursive control flow, so
their comparison isolates persistent Store copies from owned Store writes. The
structural lane deliberately changes the algorithm and is a
readability-versus-cost comparison, not part of that isolation claim. The owned
lane's algorithm is `@forall T` and accepts an ordinary comparator; it has no
`Int`-specific partition worker or compiler-recognized algorithm.

All three lanes sort the same deterministic shuffled permutation. Its first
element is host-supplied so staging cannot precompute the result. The benchmark
checks a full order-sensitive checksum, instruments gpupaper's Store imports for
one execution, and reports the median of 11 executions in fresh Wasm instances
after three warmups. Compilation time excludes compiler construction and a
prelude warmup.

## Theory and expected costs

Let `C(n)` be quicksort's comparisons and `W(n)` its element writes. All three
lanes retain average `O(n log n)` and worst-case `O(n^2)` comparison work.

The structural lane has the familiar recurrence
`T(n) = T(k) + T(n-k-1) + decomposition + partition + joins`. With contiguous
Stores, `uncons` copies its remainder. Stable partition and `<>` grow persistent
Stores; the JavaScript runtime copies the existing backing Store at each growth.
That makes balanced recursive levels approximately `O(n^2)` in element-copy work
and the maximally unbalanced case `O(n^3)`. This is the price of the shortest
pure formulation under the current representation, not a semantic requirement of
`uncons`, partition, recursion, or the monoid operator.

The persistent-update lane performs `W(n)` logical Store writes. The gpupaper
runtime implements each persistent write by copying the entire backing Store, so
the element-copy term is `O(n W(n))`: average `O(n^2 log n)` and worst-case
`O(n^3)` for this representation.

The owned-region lane acquires one `Slice`, consumes and returns its authority,
and freezes it once sorting ends. Its `W(n)` element writes mutate the same
uniquely owned Store, making the write term `O(W(n))` with zero persistent
element-Store copies after acquisition. Both update lanes recurse into the
smaller partition and leave the larger self-call in tail position, so tail-loop
recovery bounds their call stacks to `O(log n)` without a range worklist.

## What the measurements establish

- Store import call counts classify dynamic writes and growth operations.
- HIR mutation-site counts verify that structural quicksort uses only persistent
  growth, smaller-first persistent quicksort uses persistent writes, and the
  owned element path uses only owned writes.
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

Measured 2026-08-22 on Node 26.7.0 and Linux x86-64:

|   n | structural median | persistent median | owned median | structural Wasm | persistent Wasm | owned Wasm |
| --: | ----------------: | ----------------: | -----------: | --------------: | --------------: | ---------: |
|  16 |         280.78 us |         186.73 us |    143.09 us |         6,723 B |         9,192 B |    7,377 B |
|  32 |         494.31 us |         634.11 us |    341.99 us |         7,176 B |         9,654 B |    7,861 B |
|  64 |         723.84 us |         544.55 us |    425.80 us |         8,156 B |        10,632 B |    8,839 B |
| 128 |       1,718.71 us |       1,155.08 us |  1,250.38 us |        10,204 B |        12,680 B |   10,887 B |

For every size, structural quicksort imported only `store_grow_persistent` and
executed no Store writes; the persistent-update artifact imported only
`store_write_persistent`; and the owned artifact imported only
`store_write_owned` for element mutation. At `n = 128`, the structural lane
issued 642 Store new/empty operations and 2,896 persistent growth calls; the two
update lanes constructed one source Store and made 832 element writes. The owned
lane made all 832 as `owned-reuse` and zero as persistent writes. Repeat runs
preserved those structural results; local timing order between the two
persistent formulations and the largest owned case varied, as expected for short
fresh-instance runs. The update classification and allocation counts are the
regression boundary; these timings are descriptive rather than a gate.

## Functional readability baseline

`structural_quicksort.blot` is the executable source for the functional lane:
`Array.uncons` decomposes one element, `Array.partition` performs the stable
classification, `<>` is ordinary array-monoid append, and non-tail recursion
becomes a residual `call.direct`. Proof-refined dynamic `@array.take` and
`@array.split` return plain tuples and compile to generic Store length/read/grow
operations and control flow in both compiler implementations. No
collection-algorithm opcode crosses Runtime HIR.
