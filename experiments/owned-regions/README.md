# Owned-region benchmark

`pnpm benchmark:owned-regions` measures the production smaller-first Slice
quicksort across deterministic shuffled inputs. It is a scaling and lowering
regression test, not a comparison between unrelated algorithms.

The older structural and persistent lanes predated owned-until-shared Arrays.
They relied on treating a shared recursive Store as if it could become unique at
the next call. Blot now rejects that implicit promotion instead of inserting a
hidden copy, so those lanes are no longer benchmark inputs.

The measured program is `@forall T`, accepts an ordinary comparator, and uses no
quicksort-specific compiler operation. Its first element is host-supplied so
staging cannot precompute the result. For each size the benchmark checks a full
order-sensitive checksum, compiles once, warms three fresh Wasm instances, and
reports the median of 11 more fresh-instance executions.

## Theory and regression boundary

Let `C(n)` be comparisons and `W(n)` element writes. The implementation retains
average `O(n log n)` and worst-case `O(n^2)` comparison and write work. It owns
one Store, recurses into the smaller partition, and leaves the larger recursive
call in tail position, so tail-loop recovery bounds the call stack to
`O(log n)`. It uses `O(1)` auxiliary element storage and performs no persistent
element copies after acquisition.

The semantic gate is structural:

- Runtime HIR contains owned-reuse writes and no persistent writes;
- emitted Rust-backend Wasm imports neither persistent nor owned Store-write
  helpers, because certified owned writes become direct linear-memory writes;
- the result checksum agrees for every input size; and
- Wasm byte size and local timing remain visible regression signals.

The `store.grow` sites shown by the benchmark construct the dynamic source
literal. They scale with the literal length but are owned and occur before the
sort. The four `store.write` sites are the sort's source-level mutation paths.

## Local result

Measured 2026-08-23 on Node 26.7.0 and Linux x86-64:

|   n |   median | Wasm bytes | owned grow sites | owned write sites | persistent sites | Store imports |
| --: | -------: | ---------: | ---------------: | ----------------: | ---------------: | ------------- |
|  16 | 12.92 us |      7,822 |               16 |                 4 |                0 | none          |
|  32 | 24.62 us |      8,845 |               32 |                 4 |                0 | none          |
|  64 | 40.21 us |     11,106 |               64 |                 4 |                0 | none          |
| 128 | 82.02 us |     15,778 |              128 |                 4 |                0 | none          |

Timings are descriptive, not portable native-code claims. Mutation kind and the
absence of persistent sites/imports are the regression boundary.

## Zipper variant

[`examples/region_zipper_quicksort.blot`](../../examples/region_zipper_quicksort.blot)
shows the structural alternative. A partition returns disjoint left, pivot, and
right Regions plus two rejoin witnesses. Recursive calls consume the children,
then the return path reconstructs the root:

```text
root -> (left, pivot+right) -> (left, pivot, right)
     <- join(left, pivot+right) <- join(pivot, right)
```

That form is useful when children must be independently live or sent to
unrelated callees. It is not the default benchmark because maximally unbalanced
input can retain `O(n)` reconstruction frames, while the sequential
smaller-first version guarantees `O(log n)` stack.
