# Demand-driven open checking

The profile that motivated this change was a changed-module check of
`examples/storage.blot` on the Node development compiler. `freshenAbove` was the
largest non-GC self-time: importing/opening the large prelude recursively copied
record-scheme fields even when the program used only a small subset. Free-name
analysis was another repeated pure traversal over unchanged dependency ASTs.

The implementation follows the open-frame and incremental-memoization rules in
`spec/TYPECHECKING.md`, `spec/INCREMENTAL.md`, and
`spec/DEMAND_CHECKING.md` instead of introducing a new semantic cache boundary:

- record scheme fields share one instantiation memo and freshen on demand;
- inert record-to-fresh-variable lower bounds stay suspended until they can be
  observed or propagated;
- pure free/pinned/bound-name queries are memoized by exact immutable AST
  identity.

Four paired local before/after runs used 101 width-changing semantic revisions
of `examples/storage.blot` per side. Each row reports the median
`Compiler.check` time for that side. Baseline and branch runs were interleaved to
reduce drift from JIT and host load.

| run | merged main | branch | improvement |
| ---: | ----------: | -----: | ----------: |
| 1 | 69.927 ms | 64.564 ms | 7.7% |
| 2 | 68.055 ms | 56.178 ms | 17.5% |
| 3 | 62.239 ms | 58.248 ms | 6.4% |
| 4 | 69.429 ms | 60.349 ms | 13.1% |

The median paired improvement is **10.4%**. The observed range is **6.4–17.5%**,
so the PR treats the profile attribution and asymptotic work reduction as the
primary result rather than claiming one machine-independent percentage.

These timings measure the changed module's check only; parsing, Runtime HIR
preparation, and gpupaper emission are outside this clock. The repository's
nine-sample complete benchmark is intentionally not used for the before/after
headline here because local end-to-end runs were noisier than this longer
checker-specific experiment. PR CI remains the authoritative correctness and
Node/Rust parity gate.

This is deliberately not a dependency-interface cache. Mutable inference facts
still participate in the complete root judgment exactly as before. The next
interface-cache step must satisfy the closed-certificate rules in
`spec/INCREMENTAL.md`; this change first removes work that the existing
open-frame theory already says is unnecessary.
