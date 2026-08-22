# Owned Array runtime quicksort

This experiment keeps both one input element and the comparator direction behind
a host effect. The compiler therefore cannot pre-sort the Array or erase the
comparator closure. It measures the emitted Wasm against a baseline that
constructs and checksums the same Array without sorting it.

```sh
pnpm benchmark:owned-arrays
```

The benchmark reports shuffled and already-sorted inputs at several sizes. It
checks the contract before timing:

- Runtime HIR contains recursive calls and tail back-edges;
- every `store.write` and `store.grow` is `owned-reuse`;
- every function that writes a Store carries a checked reuse assertion;
- the Wasm validates, imports only the declared host effect, and returns the
  expected checksum; and
- repeated sorts over a fixed construction volume grow linear memory by the same
  number of pages as the construction-and-checksum baseline.

The expected comparison bounds remain average `O(n log n)` and worst-case
`O(n^2)` for the last-element pivot. Store construction is `O(n)`. Once that
owned Store exists, sorting allocates no auxiliary element Store and uses
`O(log n)` non-tail call depth because the smaller partition is evaluated first.
