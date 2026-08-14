# Baba → gpupaper incremental performance

Paired local Node-only measurements for `examples/storage.blot` compare current
`main` with this branch. Each row is the median across four interleaved
before/after trials; each trial uses the benchmark's nine-sample median.

| Boundary                      |      main | this branch |       change |
| ----------------------------- | --------: | ----------: | -----------: |
| runtime-neutral semantic edit |  83.05 ms |    70.64 ms | 14.9% faster |
| check phase                   |  72.37 ms |    65.34 ms |  9.7% faster |
| prepare after check           |   1.91 ms |     2.08 ms |     +0.17 ms |
| compile after prepare         |   3.75 ms |     0.50 ms |   86.6% less |
| cold end-to-end               | 456.75 ms |   445.66 ms |  2.4% faster |
| comment-only edit             |   8.80 ms |     8.70 ms |    unchanged |

The semantic edit changes a dead private literal from `1` to `100`, so it forces
a fresh source/check revision and shifts source spans while leaving Runtime HIR
behavior unchanged. The final emission result is compared byte-for-byte with a
fresh compiler rebuild in the regression test.

The remaining changed-module cost is still dominated by TypeScript inference.
This branch only caches work that is independent of importer inference: AST-only
dependency discovery and linearity, plus an already-successful emitted artifact
when a fresh Runtime HIR is equal after removing source locations.
