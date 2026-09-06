# Live report: inference across editor revisions

This study extends the engine's hot-reload concern without requiring WebGPU,
network access, or a window. Two independently inferred views import one shared
configuration; that configuration includes a heading file. A public report
exports a heading and a scalar scoring function with a runtime quantity.

```text
main.blot -> score.blot   -> config.blot -> label.txt
          -> heading.blot -> config.blot
```

Run from the repository root with the matching compiler distribution installed:

```sh
node --import tsx src/node/cli.ts check case-studies/live-report/main.blot
node --import tsx --test case-studies/live-report/live_report.test.ts
node --import tsx src/node/cli.ts run examples/inferred_report_views.blot
```

The test copies the sources into temporary directories. It never edits these
checked-in fixtures. The smaller example selects two fields from differently
shaped records and returns `42`; it does not claim to preserve unselected fields.

## Inference and the public boundary

`score.blot` infers `{ .quantity = Int } -> Int`, while `heading.blot` infers
`{ .name = Text } -> Text`. Neither library view requires a record declaration or
an annotation. The report passes extra fields and exports
`{ .heading = Text; .score = Int -> Int }`. Tests assert these exact printed types,
not just successful compilation. Runtime inputs `0`, `1`, `21`, and `-3` exercise
the emitted scalar export, independently of its sample record.

The public scalar function deliberately has an explicit ABI signature. During
exploration with the published `e60b49d` compiler distribution, removing that
signature from this imported-wrapper shape produced `⊤ -> Int` and a
`BLOT_UNSUPPORTED_LOWERING` target refusal when exporting it. The explicit
signature closes the public boundary while preserving inference in the views.
This observation is not a claim that an arbitrary open principal type has a
first-order Wasm ABI, nor a solver fix. Recheck the unannotated variant against a
rebuilt compiler before generalizing that finding to a newer compiler revision.

## The failures exposed by live editing

Start with weight `2` and quantity `21`: the emitted result is `42`. Keep an
unsaved editor overlay changing the weight to `3`: the result becomes `63`.
Then change only `label.txt` from `Warehouse A` to `Warehouse B`.

Previously, refreshing the included file evicted its importing source node.
Reloading that node as a dependency read the disk source rather than the editor
revision, even though the overlay still existed in workspace metadata. The
heading updated, but the result silently reverted to `42`. More seriously, an
unsaved text weight that correctly failed inference became an apparently valid
program after the same include refresh. This was an input-graph bug, not evidence
that the Rust checker accepted text multiplication.

The loader now resolves effective source bytes for every dependency from the
same staged overlay map as the root. The overlay is reapplied lazily when a node
is invalidated or evicted, before resolving its imports. Snapshot and capsule
nodes keep their existing authority. Clearing an overlay explicitly restores
the disk source; releasing a root does not silently clear its retained overlay.

The four executable scenarios cover principal types and runtime inputs;
include refresh with an unsaved shared dependency and fresh-session agreement;
a real, located type error followed by repair and overlay removal; and reopening
an overlay-backed dependency after releasing its roots and deleting its disk
file. The last case ensures correctness does not accidentally depend on a warm
loaded-node cache.

## Scaling the same topology

A chain of shared diamonds extends this small report into a pathological
workspace. See [the workspace-graph experiment](../../experiments/workspace-graph/README.md)
for generated Blot programs, real Wasm qualification, per-node traversal counts,
and a low-file-descriptor regression. The host repairs do not change inference
rules, module-instance identities, the compiler-host ABI, or emitted-code cost.
