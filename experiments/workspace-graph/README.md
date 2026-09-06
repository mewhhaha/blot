# Shared-import and wide-refresh pathologies

This experiment scales the shared configuration in the
[live-report study](../../case-studies/live-report/README.md). A depth-`d` diamond
chain has `2d + 2` reachable modules but exponentially many import paths. The
loader must resolve shared nodes, not recursively unfold every path.

```sh
node --import tsx experiments/workspace-graph/benchmark.ts --depths=4,8,12 --samples=3
node --import tsx --test src/load_pathologies.test.ts
```

The benchmark first writes actual Blot source for each topology, checks it using
the Rust compiler, emits Wasm, and verifies its result is `2 ** (depth + 1)`.
Only then does it measure the corresponding retained host graph. The measured
nodes intentionally throw if syntax is materialized. This separates dependency
traversal from filesystem work, parsing, inference, staging, and emission.
Reported compiler manifest identity describes the qualification compiler, not a
newly rebuilt binary. Each sample gets its own graph and operation-local memo.

The JSON report preserves raw time samples and dependency-visit counts. Time is
informational, not a CI threshold. The deterministic regression requires every
reachable node to be expanded once per load, including a second request against
the same retained graph. Its largest fixture has 66 modules at depth 32. A
separate source-backed test changes the shared leaf, verifies both parents see
the replacement without reparsing their own ASTs, and introduces a cycle after a
successful load to ensure memoization cannot hide it.

## Reproduced before and after

With Node 22.16.0 and the published compiler/workspace for
`e60b49dac2ae5100fb3e0b5ec46b343f9ff5a060`, three samples at each size produced:

| Depth | Reachable modules | Original expansions | Fixed expansions | Wasm result |
| ----- | ----------------- | ------------------- | ---------------- | ----------- |
| 4     | 10                | 47                  | 10               | 32          |
| 8     | 18                | 767                 | 18               | 512         |
| 12    | 26                | 12,287              | 26               | 8,192       |

The original `src/load.ts` and `src/workspace_graph.ts` are unchanged between
that reference commit and reviewed main
`e9f32423502bfbe4d927608b98c96211f71ecf96`. Restoring those two original files made
eight of the ten initial focused regressions fail; applying the repairs made all
ten pass. Other compiler files differ between those revisions. These local
results do not establish that the complete current-main compiler, Rust suite,
or CI pipeline has passed. The PR's normal rebuilt-compiler CI remains the
integration authority.

## Why the loader changed

The old rebind recursively revisited a cached node for each incoming path. The
new completed-node memo is scoped to one load operation. Active-path cycle
checking precedes memo lookup; incomplete nodes never enter the memo. A new
request gets a new memo, so edits and package-resolution changes cannot be
masked by a permanent visited set. This bounds node expansion and edge visits,
not all compiler work: active-path scans/copies and source resolution have their
own costs. It is not a claim of polynomial inference or faster emitted Wasm.

Refreshing a wide workspace also used one concurrent file read per input. The
regression launches a process with a 64-descriptor limit and refreshes 512 source
files, then modifies one and removes another. Previously this failed with
`EMFILE`. Sixteen draining workers now bound concurrent refresh reads, and
invalidation occurs only after successful completion. The test skips Windows,
where the POSIX descriptor-limit command is unavailable. The bound does not
protect against descriptors independently exhausted elsewhere in the process.

Unexpected refresh errors drain the reads already in flight before rejecting;
they do not publish partial invalidation. Missing files remain changed inputs,
so the subsequent load reports their normal source-resolution failure.

## Validation boundaries

`src/load_pathologies.test.ts` covers graph work and refresh resource pressure.
`case-studies/live-report/live_report.test.ts` covers exact principal types,
located errors, editor revision recovery, and emitted runtime observations.
Neither replaces the full compiler or conformance suites. All normal regression
discovery remains enabled; no benchmark limits, compiler checks, or CI gates are
weakened. Use smaller depths when measuring the original exponential traversal.
