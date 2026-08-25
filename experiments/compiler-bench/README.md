# Unified compiler benchmark

This harness records named compiler boundaries in one deterministic JSON schema.
Scenarios run serially so they do not compete for one process. Cold-process
samples launch a new Node process, cold-compiler samples create a new compiler,
and warm uncached samples use a distinct source path for every revision. Each
scenario checks that its public type and effects remain unchanged. Generative
effect numbers are deterministically alpha-renamed across the complete
observation, preserving which occurrences share an identity, because a different
written import occurrence must mint a different numeric identity. Closed and
open effect-row labels are compared in canonical order.

Cold-process duration is an operational wall-clock boundary through result
collection and child exit, including result transport and teardown after the
completed check. The compiler-only boundaries stop their clocks at the named
operation.

```bash
pnpm benchmark:compiler -- examples/minimal.blot --samples=31 \
  --output=experiments/compiler-bench/latest.json
```

Every scenario reports the median, median absolute deviation, p90, and p95. The
report-level source byte count describes the unedited workload; each sample
records the exact source revision measured by that operation.
`pnpm benchmark:compiler-suite` repeats those samples three times for minimal,
terminal, and agent workloads. `pnpm benchmark:compiler-compare` applies the
documented 10% improvement and 5% regression thresholds to two suite reports.
Each candidate target-run median must clear the improvement threshold relative
to the aggregate baseline and exceed three times the larger median absolute
deviation; independent runs are not paired by array index. The aggregate target
improvement must clear the same noise threshold. Aggregate regressions and every
non-target candidate-run regression are checked against the aggregate baseline
with the same percentage and noise gates, so pooling cannot hide one slow run.

```bash
pnpm benchmark:compiler-compare -- baseline.json candidate.json
```

Suite reports retain the exact benchmark- and host-input digests, compiler
artifact and manifest identities, toolchain versions, stable workload paths,
path-independent source-graph identities, and a compact execution-environment
identity. Every run also retains its raw durations; comparison recomputes each
run summary and the pooled summaries instead of trusting reported percentiles.
The environment records platform, architecture, CPU models/count, and a
path-stable digest of Node flags and `NODE_OPTIONS`. Comparison rejects a
different environment, benchmark inputs, versions, paths, source graphs, sample
counts, run counts, or workload/scenario matrices. Host inputs cover the runtime
`src` tree, generated Baba runtime artifacts, the prelude snapshot, checked-in
package and dependency configuration, relevant untracked files, and the ignored
generated `.pnp.cjs` loader that Node executes. Each detailed run captures those
inputs before its first sample and after its last; a change rejects the run
instead of attributing timings from mixed revisions to either capture.

Ordinary pull requests gate deterministic work counters. Wall time, RSS, and
compiler memory observations are trend data for scheduled runs.
