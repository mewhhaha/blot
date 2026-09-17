# Full-compilation latency budget

This draft continues from PR #171 at `92972a5` without modifying its reviewed
source. The target is 100 ms for a genuinely compiled application, not a cache
hit relabeled as compilation. No result at that target is currently established.

Measure three different operations explicitly:

- Cold: the first complete compilation in a fresh process and compiler session.
- Edited: compilation after a source change, including invalidation and checking.
- Unchanged: a revision-cache hit, reported separately as a control.

Compiler loading and initialization, source checking, runtime preparation, final
emission, and process wall time must remain visible. A change that merely moves
work outside the measured interval is not a compiler speedup.

The next experiments profile the remaining source checking and transitive
capture/type-evidence construction on the production compiler. Any reuse must
preserve source diagnostics, dependency revisions, exact structural evidence,
quantifier and effect identities, ownership, and mutable-region independence.
Fresh-process paired measurements require identical inputs, build settings, and
output equality. Profiles and diagnostic builds are not production timing data.

The application snapshot remains private. Do not publish application source,
Wasm, ABI contents, or source-bearing profiles in this public repository.
Synthetic regressions and aggregate measurements belong here.
