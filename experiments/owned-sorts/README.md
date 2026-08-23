# Owned-sort benchmark

`pnpm benchmark:owned-sorts` compares the four coherent `Array` sorting APIs on
the same deterministic shuffled `Int` inputs:

- `Array.quicksort` is generic, unstable, in-place, average `O(n log n)`, and
  uses `O(log n)` call state after smaller-first recursion recovery;
- `Array.merge_sort` is generic, stable, `O(n log n)`, and alternates one Array
  with one initialized-prefix Scratch allocation;
- `Array.radix_sort (_, _, Radix.unstable)` caches one key per element and uses
  bytewise American-flag permutation in place;
- `Array.radix_sort (_, _, Radix.stable)` caches one key per element and uses a
  stable bytewise scatter buffer.

The first input is host-supplied so staging cannot precompute a result. Every
lane compiles through the Rust/Wasm compiler, checks the complete
order-sensitive checksum, validates the emitted Wasm, counts Runtime-HIR Store
and Scratch sites, and reports memory-page growth over repeated calls. Timings
include construction of the identical dynamic Array and are local regression
signals, not portable native-code claims.

The theoretical boundary is deliberately not hidden behind algorithm-specific
compiler recognition. Generic comparison sorts remain `O(n log n)`; radix is
`O(k(n + 256))` for the `k` significant bytes selected by the signed-key mode.
Key extraction is one source call per input element in both radix lanes. Scratch
is the only extra mutable representation and never crosses the ABI.

Run the benchmark after building the compiler artifact. Record local results
here only when the machine and runtime version are also recorded.

## Local result

2026-08-23, Node v26.7.0, Linux 7.1.8 x86-64, AMD Ryzen 7 3800X. Times are the
median of seven samples, with 32 calls per sample after three warmups.

| algorithm      |   n | compile ms | median us | Wasm bytes | Store writes | Scratch ops | pages / 64 |
| -------------- | --: | ---------: | --------: | ---------: | -----------: | ----------: | ---------: |
| quicksort      |  32 |     1341.6 |     17.50 |      9,468 |            4 |           0 |          0 |
| merge          |  32 |      493.9 |     36.30 |     14,428 |            0 |           7 |          0 |
| radix unstable |  32 |      599.1 |    102.28 |     48,787 |            7 |           7 |          0 |
| radix stable   |  32 |      579.8 |     46.77 |     45,600 |            4 |           7 |          0 |
| quicksort      | 128 |      465.6 |     76.84 |     23,421 |            4 |           0 |          0 |
| merge          | 128 |      472.0 |    181.96 |     35,313 |            0 |           7 |          0 |
| radix unstable | 128 |      593.8 |    247.59 |     90,639 |            7 |           7 |          0 |
| radix stable   | 128 |      598.5 |    144.33 |     87,452 |            4 |           7 |          0 |

The fixed-cost byte histogram dominates these small radix inputs, as expected;
the result is evidence of the intended memory behavior and coherent lowering,
not a claim that radix beats comparison sorting at every size.
