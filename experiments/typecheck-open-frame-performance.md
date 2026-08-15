# Theory-driven open-frame checking performance

This experiment follows the representation obligations in
`spec/TYPECHECKING.md` and `spec/COST_MODEL.md`: opening an immutable compile-time
record should share its field table, and one scheme instantiation should not
rescan the same immutable type subtree from multiple parents.

The measured workload is `examples/storage.blot`, whose ordinary
`open @import "blot:prelude" ()` exposes a large nullary module result. A resident
`Compiler` is primed once, then the root receives 60 semantic revisions by
inserting a changing dead `let benchmark_revision = N` immediately before the
module result. Every revision therefore reloads and rechecks the root while the
prelude dependency remains unchanged.

Three independent baseline runs on merged `main` measured median changed-module
checks of 66.34 ms, 63.83 ms, and 66.59 ms. Three runs with this change measured
61.51 ms, 61.31 ms, and 61.43 ms. The median of those run medians moves from
66.34 ms to 61.43 ms, about **7.4% less checker time**.

A temporary freshening profile on one cold `storage.blot` check also reduced
reported `freshenAbove` time above the 0.05 ms sampling threshold from 14.94 ms
to 10.83 ms, about **27.5% less measured scheme-freshening work**.

The optimization has two parts:

1. For a nullary imported record whose application variables are disjoint from
   the result, constrain only the parameter/effect slice and retain the result
   field table. Each opened field is installed as its original scheme and is
   freshened only when that binding is used.
2. Within one scheme instantiation, memoize the `levelBelow` predicate by type
   identity as well as memoizing freshened copies. Shared structural subtrees are
   therefore classified once per instantiation.

Neither optimization caches mutable inference results across root checks. If a
module application can constrain its result, the checker falls back to the
ordinary complete instantiation path.
