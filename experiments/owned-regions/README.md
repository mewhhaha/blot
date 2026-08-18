# Quicksort representation benchmark

`pnpm benchmark:owned-regions` compares three valid ways to express quicksort.
They answer two separate questions:

| lane | formulation | question |
| --- | --- | --- |
| `functional-array` | `uncons`, stable `partition`, recursion, and `<>` | What does the shortest algebraic program cost? |
| `persistent-update` | an iterative range worklist and `Array.set` swaps | What do persistent element updates cost with the same control flow as the owned program? |
| `owned-region` | the same range worklist and `Slice.partition_range` | What changes when unique authority permits in-place writes? |

The first lane is the readability baseline. It deliberately changes both the
algorithmic formulation and the representation, so its timing must not be used
alone to attribute a speedup to ownership. The latter two lanes have equivalent
partitioning and worklist structure; their comparison isolates persistent Store
copies from owned Store writes.

All lanes sort the same deterministic shuffled permutation. Its first element is
host-supplied so staging cannot precompute the result. The benchmark checks a
sorted-output checksum, instruments gpupaper's Store imports for one execution,
and reports the median of 11 executions in fresh Wasm instances after three
warmups. Compilation time excludes compiler construction and a prelude warmup.

## Theory and expected costs

Let `C(n)` be quicksort's comparisons and `W(n)` its element writes. All three
lanes retain average `O(n log n)` and worst-case `O(n^2)` comparison work.

The functional lane partitions into fresh arrays and concatenates results. Its
surface program is minimal, but partition and append introduce allocation and
copy work at each recursive level. Balanced inputs therefore retain average
`O(n log n)` aggregate collection work, while unbalanced inputs can reach
`O(n^2)`. The compiler may safely reuse uniquely consumed intermediate arrays;
the observed persistent/owned growth imports report whether it does.

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
