# Owned ordered-map benchmark

`pnpm benchmark:owned-maps` compares updating every value of the same sorted
text-keyed map in two representations:

- `persistent-map` updates the same ordered association array with `Array.set`;
  every replacement persistently copies the Store; and
- `owned-ordered-map` validates and copies one `OrderedTextMap`, then every
  replacement binary-searches the key and performs one owned Store write.

Both programs receive the replacement base through the same host effect, update
the same entries in key order, and return the same first/middle/last checksum.
The persistent control is intentionally given its already-known element index,
while the owned map still binary-searches the key; this biases time toward the
persistent control and keeps the comparison focused on Store-copy cost.

## Cost model

For `n` entries and `n` updates, the persistent form performs `O(n²)`
element-copy work. The owned form performs `O(n log n)` comparisons, `O(n)`
destructive writes, and no persistent element-Store write after acquisition. The
one-time sortedness validation and explicit copy are `O(n)`.

The benchmark validates observations before timing, reports the median of 11
fresh-instance executions after three warmups, records complete Wasm size and
compile time, and instruments gpupaper Store imports. Absolute timings are
machine-local; the owned-versus-persistent Store operation classification is the
semantic regression contract.

## Representative measurement

Node 24.19.0 on 2026-08-18 produced:

| Entries | Persistent median | Owned median | Persistent writes | Owned writes |
| ------: | ----------------: | -----------: | ----------------: | -----------: |
|      16 |          61.22 us |    179.86 us |                16 |           16 |
|      32 |          54.72 us |    404.03 us |                32 |           32 |
|      64 |         102.48 us |    741.59 us |                64 |           64 |
|     128 |         210.80 us |  1,548.12 us |               128 |          128 |

Every persistent write used `store.write/persistent`; every owned-map write used
`store.write/owned-reuse`. The owned adapter is slower in this deliberately
adverse time comparison because it performs a text-key binary search for every
update while the control receives each exact array index. Its present benefit is
authority-safe in-place replacement and bounded Store-copy work, not a claim
that text comparison is cheaper than a known integer index.
