# Resident closed-leaf check reuse

This experiment measures the first full TypeScript checker reuse boundary from
`spec/TYPECHECKING.md`: an unchanged dependency may reuse its complete check when
it is a nullary leaf, its lexical specialization interface closes, and that
interface contains no generative effect brand. The check is first settled in an
isolated staging sink, so caller-specific fact reads are not retained.

`examples/storage.blot` is a useful workload because it imports the ordinary
`blot:prelude` leaf and then performs substantial structural specialization in
the edited root. The prelude is not special-cased by the implementation; it just
satisfies the same reusable-leaf predicate.

Run the existing end-to-end benchmark in Node-only mode:

```sh
pnpm exec tsx --import ./src/node/polyfills.mjs \
  experiments/node-wasm-benchmark.ts --node-only examples/storage.blot
```

Three independent nine-sample runs were taken on Node 22.16.0. The baseline is
merged PR #35; the optimized column is the resident-leaf implementation. Values
below are the median of those three run medians.

| Boundary | #35 baseline | resident leaf | Change |
| --- | ---: | ---: | ---: |
| changed-module check | 63.795 ms | 31.950 ms | **49.9% less / 2.00x** |
| changed-module compile | 72.438 ms | 37.203 ms | **48.6% less / 1.95x** |

Cold compilation remains in the same band: the three-run medians were 458.162 ms
baseline and 444.662 ms with resident leaf reuse. Source-only edits remain in
the same single-digit-millisecond band because semantic revision reuse already
avoids the checker.

The result should not be read as a universal 2x compiler speedup. It removes one
repeated dependency check from a workload dominated by a large closed leaf. The
remaining changed-root cost is still importer inference and specialization,
which is exactly what the rule deliberately re-derives.
