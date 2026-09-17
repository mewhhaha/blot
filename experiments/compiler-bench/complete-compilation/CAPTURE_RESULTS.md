# Capture graph preservation: full-compilation comparison

## Scope and result

This increment applies the previously unpublished capture-graph checkpoint on
top of `7b4292e01228839e0a94e1817a9461d8852fec77`, preserving both earlier
implementation increments. Two additional safety regressions extend the original
six capture tests. The source-derived inventory and staging contract are
updated.

The paired full-compilation median changes from **9,749.010 ms** to **4,362.048
ms**, a **-55.26%** change versus the immediately preceding PR implementation.
This is not a comparison with main and must not be multiplied by earlier
percentages. Compilation still takes seconds; the requested
millisecond-compilation goal remains unmet.

| Source-built artifact       | Samples |      Minimum |       Median |       Maximum | Median initialization |
| --------------------------- | ------: | -----------: | -----------: | ------------: | --------------------: |
| Previous PR head, `7b4292e` |       6 | 9,427.378 ms | 9,749.010 ms | 10,847.582 ms |            110.766 ms |
| Capture graph preservation  |       6 | 4,204.010 ms | 4,362.048 ms |  4,755.259 ms |            114.580 ms |

[capture-samples.jsonl](capture-samples.jsonl) retains all twelve observations.
Six rounds alternate baseline/candidate and candidate/baseline order. Each
invocation creates a fresh process and compiler session, with no hidden warmup
or discarded sample. No local compiler build, test suite, or profiler runs
during the latency batch. The parent-enforced 90-second timeout was never
reached. Operating-system and file-system caches are not deliberately flushed.
This small shared-host batch is workload-specific evidence, not a portable
confidence bound.

The timer covers the first complete `Compiler.compile`, including final
executable emission. Initialization is reported separately. Script startup,
artifact reads, input hashing, output validation, optional output writing, and
teardown are outside the compilation interval and included in `processWallMs`.
Every first result reports `compiled`, not `revision-cache`; no unchanged-source
cache-hit interval is substituted for actual compilation.

## Output equivalence and provenance

All twelve observations use the same immutable private workload snapshot, 10
source files totaling 162,451 bytes. Every emitted module passes Wasm
validation, and the application Wasm and ABI are **byte-identical** across all
twelve runs. Equality was checked using both hashes and direct byte comparison
outside the timed interval. No private source, executable, ABI contents, or
source-bearing stderr is published.

- Input closure SHA-256:
  `f63d9769b9919783335875b79b608649bc9a93fe7b97d33a700004b55b1b04b8`.
- Emitted module: 1,479,176 bytes; SHA-256
  `17a3738580c7d41b8fdfa9af3a47be0ab09045338bc819e0fde43400c1da0f4e`.
- ABI SHA-256:
  `41f843861884e86166ce88e63b74e6c70dd3254c8e2738e1a81355eba5ae6ca5`.
- Unchanged tracked snapshot SHA-256:
  `87718708480be1ebe78c1c6cff3944c8e78cafce48157495dad3c780df7bd57f`.
- Tested `compiler/src/hir.rs` Git blob:
  `78b58cae3c7b1bfb4f986ce73155287649151613`.

Input digests include absolute source paths and are not relocation-invariant.
They establish equality within this checkout, not equality of hashes across
previous hosts or checkout locations. The measured source tree for the baseline
was verified against the published Git tree
`b6e1ce7b70b09ffca4cd1bca093b8b8b791bd55b` before building.

Both artifacts were rebuilt with pinned Rust 1.97.1, the same locked vendored
dependencies, and the unmodified production `scripts/build_compiler.ts --check`
command: size optimization, fat LTO, one codegen unit, and the configured 8 MiB
Wasm stack. Both pass the original prelude snapshot freshness check; no snapshot
golden was rewritten. The runtime is Deno 2.9.7 with default tiering, not Node.
The `node` property in `runtimeVersions` is Deno's compatibility version.

| Artifact  | Compiler bytes | Compiler SHA-256                                                   | Semantic input SHA-256                                             |
| --------- | -------------: | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Baseline  |      7,289,006 | `275bcec42a6768854c29380fe2653f5eb3a5d7fc81addcb06a04fb8c62e8f37d` | `e1cad9f699920fccfb382437dabcbb2334bfbe89fd34930adc5dbd5495618d2c` |
| Candidate |      7,297,701 | `3603c6063e6b299b9cbc13ba0f113a2d3095d365c78e317807981d6e72d36a99` | `8e657674d9e88addadd8a35b44cc386e8449c50a407e5b8eecd6654bb4d2791b` |

The candidate was built before committing its patch; the generated distribution
manifest consequently records the pre-commit parent. Its semantic-input digest
and the tested source blob above identify the measured implementation. Hosted CI
independently rebuilds the published commit rather than treating this local
artifact as evidence of a fresh hosted build.

## Eliminated work and safety boundaries

Capture discovery previously revisited every path through shared immutable
records and function/range type edges. Runtime-slot replacement rebuilt those
paths as independent trees. Each operation now retains input owners and memoizes
completed immutable storage nodes, preserving output sharing under one fixed
replacement mapping. No cache survives into another request.

Discovery preserves the existing closure-cycle guard, first-encounter slot
meaning, staging requirements, and slot identity. In particular, an in-progress
record reached through a recursive closure is not prematurely marked complete.
Rewriting preserves the existing recursive-environment map and does not cache a
record or type edge whose rewrite creates a fresh mutable-region copy. Such
copies retain independent mutable authority.

The eight focused regressions pass. Depth-24 record diamonds require at most 49
value visits; depth-24 function-type diamonds require at most 25. These are
synthetic deterministic work bounds, not measured counts for the private
application. The other tests exercise distinct replacement mappings,
copy-on-write mutations, current mutable cells, independent region copies under
both records and type edges, and a recursive record whose first runtime meaning
and later staging requirement must both be retained.

The parser, subtype solver, effect identities, ownership rules, canonical ABI,
residual-sharing eligibility, and source evaluation semantics are unchanged. No
test is removed, no timeout or performance threshold is increased, and no
standard CI workflow is changed. Full native, abstraction, regression,
conformance, and exact-head hosted validation are recorded in the PR discussion
when those runs complete; pending runs are not described as passing here.

## Reproduction

Use the commands in [README.md](README.md) with each distribution and the same
local entry point. Build both sides from source, preserve all twelve
fresh-process observations and alternating order, and compare input/output
identities. The harness accepts an entry point and never embeds the private
workload. The earlier experiments remain separate records in
[RESULTS.md](RESULTS.md) and [SHARING_RESULTS.md](SHARING_RESULTS.md).
