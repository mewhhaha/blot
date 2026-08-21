# Progressive typed-Core to Runtime-HIR boundary

This experiment measures the completion condition in `TASKS.md`: checking and
Runtime-HIR preparation must share the checked artifact, preserve exact source
origins, and improve their combined boundary without changing the emitted
artifact.

The workload is `examples/storage.blot`, which imports the ordinary closed
prelude leaf and exercises structural specialization. Run:

```sh
pnpm exec tsx --import ./src/node/polyfills.mjs \
  experiments/node-wasm-benchmark.ts --node-only examples/storage.blot
```

Three independent nine-sample runs were taken on Node 22.16.0. The table uses
the median of the three run medians. `main` is commit `3ada9ab`; progressive is
this implementation.

| Boundary                     |      main | progressive |    Change |
| ---------------------------- | --------: | ----------: | --------: |
| source-only edit             |  7.367 ms |    7.614 ms |     +3.4% |
| changed-module check         | 34.542 ms |   31.959 ms |     -7.5% |
| prepare after check          |  1.980 ms |    4.000 ms |     +102% |
| **check plus prepare**       | 36.521 ms |   35.959 ms | **-1.5%** |
| emit after prepare           |  0.419 ms |    3.920 ms |     +835% |
| complete changed-module edit | 39.036 ms |   45.164 ms |    +15.7% |

The combined semantic boundary improves rather than moving the same work from
`check` to `prepare`. The larger emission number is intentional and belongs to a
separate correctness repair: `main` reused a prior artifact when the inserted
dead declaration left runtime behavior equal even though it shifted later source
spans. The progressive compiler rebuilds that artifact because origins are
observable. A trailing comment that changes no accepted node or span stays in
the same single-digit-millisecond reuse band.

The progressive benchmark also records the high-water `heapUsed` observed after
each phase across its nine samples. The three-run medians were 145,163,600 bytes
after checking, 141,273,136 after preparation, and 141,075,552 after emission.
These are phase-boundary heap observations, not a claim about process RSS
between sampling points.

For the artifact check, both compilers were run against the same absolute source
path. Runtime HIR was structurally identical and the emitted Wasm was exactly
13,216 bytes with SHA-256
`0f4f07c6c80c7312cc4c81bd05ad93cd1188bb02f00d47b5b4bdb2f53cbcad36`. The
worktree-local benchmark sizes differ only when their manifest embeds the
different absolute source paths.
