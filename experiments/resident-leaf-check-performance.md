# Resident closed-leaf check reuse

This historical experiment measured a retired TypeScript checker reuse boundary.
It predates the Rust/Wasm compiler becoming the sole semantic authority and is
retained only as a migration performance record. In that implementation, an
unchanged dependency could reuse its complete check when it was a nullary leaf,
its lexical specialization interface closed, and that interface contained no
generative effect brand. The check was first settled in an isolated staging
sink, so caller-specific fact reads were not retained.

`examples/storage.blot` was useful because it imported the ordinary
`blot:prelude` leaf and then performed substantial structural specialization in
the edited root. The retired implementation did not special-case the prelude; it
satisfied the same reusable-leaf predicate.

This retired boundary is no longer reproducible from the current code. Current
benchmarks exercise the Rust/Wasm compiler and do not reproduce these
TypeScript-checker measurements.

Three independent nine-sample runs were taken on Node 22.16.0. The baseline is
merged PR #35; the optimized column is the resident-leaf implementation. Values
below are the median of those three run medians.

| Boundary               | #35 baseline | resident leaf |                 Change |
| ---------------------- | -----------: | ------------: | ---------------------: |
| changed-module check   |    63.795 ms |     31.950 ms | **49.9% less / 2.00x** |
| changed-module compile |    72.438 ms |     37.203 ms | **48.6% less / 1.95x** |

Cold compilation remains in the same band: the three-run medians were 458.162 ms
baseline and 444.662 ms with resident leaf reuse. Source-only edits remain in
the same single-digit-millisecond band because semantic revision reuse already
avoids the checker.

The result should not be read as a universal 2x compiler speedup. It removes one
repeated dependency check from a workload dominated by a large closed leaf. The
remaining changed-root cost is still importer inference and specialization,
which is exactly what the rule deliberately re-derives.
