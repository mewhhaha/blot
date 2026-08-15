# Resident revision-key performance

This experiment follows the recursive revision rule in `spec/INCREMENTAL.md`:
a module key is a hash of its own canonical phase inputs plus the **digests** of
its direct dependencies. The previous Node implementation instead put each
child's complete serialized key string inside the parent's JSON payload.

`examples/storage.blot` imports the ordinary Blot prelude. On the merged #32
baseline, the prelude's serialized semantic key is about 494 KB. Rebuilding the
edited root key therefore serialized roughly 609 KB even though the dependency
was unchanged. With fixed-size SHA-256 child digests, the recursive dependency
identity is 64 hexadecimal bytes and the final key is also 64 bytes.

Run:

```sh
pnpm exec tsx --import ./src/node/polyfills.mjs experiments/revision-key-benchmark.ts
```

Three consecutive local runs on Node 22.16.0 measured these median run means:

| Boundary | Nested serialized key | SHA-256 child digest | Change |
| --- | ---: | ---: | ---: |
| cold graph key, 100 iterations | 4.028 ms | 2.925 ms | 27.4% less |
| resident root after dependency keyed, 1,000 iterations | 1.431 ms | 0.073 ms | 19.7x less time |

The resident final key shrinks from 609,419 bytes to 64 bytes, and direct
prelude-key material in the parent shrinks from 493,630 bytes to 64 bytes. The
semantic key still hashes the exact portable AST including source locations, so
comment-only revisions that previously compared equal continue to compare equal,
while dependency or location-changing edits still miss.

The end-to-end changed-module benchmark moves less because type inference remains
the dominant phase. The main purpose of this change is restoring the intended
graph complexity: one canonical key derivation per module, then constant-size
identities on graph edges instead of recursively duplicated transitive payloads.
