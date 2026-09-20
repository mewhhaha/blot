# Traversal-local residual sharing results

## Full-compilation result

This batch compares three source-built production compiler artifacts on the same
private application, in a fresh Deno process and session for every observation.
The timer covers the first complete `Compiler.compile`, including final Wasm
emission. It is not a semantic-only or unchanged-cache measurement.

The latest median is **10,930.811 ms**: **24.52% lower than main** and **15.20%
lower than the first published increment**. Both percentages come directly from
this batch, not by multiplying results from different hosts or earlier
experiments. Compilation still takes seconds; **the millisecond target is not
achieved**.

| Artifact                    | Samples |       Minimum |        Median |       Maximum | Median initialization |
| --------------------------- | ------: | ------------: | ------------: | ------------: | --------------------: |
| Main, including merged #170 |       6 | 14,019.464 ms | 14,480.787 ms | 15,232.611 ms |            131.054 ms |
| First increment (`20cf793`) |       6 | 12,586.330 ms | 12,889.727 ms | 13,669.614 ms |            140.006 ms |
| Traversal-local sharing     |       6 | 10,797.561 ms | 10,930.811 ms | 11,275.451 ms |            135.018 ms |

[sharing-samples.jsonl](sharing-samples.jsonl) retains all 18 observations. The
three labels are `main`, `demand`, and `sharing`. The six rounds use all
permutations in this order: main/demand/sharing, main/sharing/demand,
demand/main/sharing, demand/sharing/main, sharing/main/demand,
sharing/demand/main. Each artifact occupies each position twice. There are no
discarded samples, hidden warmups, concurrent local builds, tests, or profilers.
The parent-enforced 90-second limit was never reached.

Compiler initialization and post-timing input hashing/output validation are
reported separately. `processWallMs` also includes script startup, artifact
reads, hashing, validation, and teardown; it is not the compiler interval.
File-system and operating-system caches are not deliberately flushed. Six
samples per artifact on a shared host do not establish a portable confidence
bound or a universal improvement across programs.

The environment is the same AMD EPYC 9V74 Linux x86-64 host with a four-CPU
quota and a 4 GiB memory limit. Deno 2.9.7 / V8 15.0.245.2-rusty uses default
tiering. The `node` field in Deno's `runtimeVersions` is its compatibility
version, not a claim that these observations were run under Node.

## Output and build identities

Every sample reports `artifactSource: "compiled"` and `wasmValidated: true`. All
18 runs observe the same 10 source files, totaling 162,451 bytes, and produce
**byte-identical executable Wasm and ABI**. This establishes output equality for
this workload; it does not replace the language and regression suites.

- Input closure SHA-256:
  `ae9dc3c5b200c0b0c47b42f0418c67e68639ccb3d8e2964b9bd622abac40e229`.
- Emitted Wasm: 1,479,175 bytes, SHA-256
  `9f4e408e8cc492b8285538bcbf50e631d73387fec8b11d57995ec129ef9f650a`.
- Emitted ABI SHA-256:
  `cbfbbf3de03af065b1f89eafcacc3d6897248e2603b8e04d0b3c6715127ff1a0`.
- Unchanged tracked prelude snapshot SHA-256:
  `87718708480be1ebe78c1c6cff3944c8e78cafce48157495dad3c780df7bd57f`.

Application source paths, source contents, Wasm, ABI contents, and raw
source-bearing diagnostic stacks are not committed. Input digests include
absolute paths; they compare the observed closure in this checkout and are not
relocation-invariant content identities.

All three artifacts use Rust 1.97.1, locked dependencies, and the normal
`scripts/build_compiler.ts` production profile: size optimization, fat LTO, one
codegen unit, and the configured 8 MiB Wasm stack. Baseline distributions were
retained from their source builds; no diagnostic binary or optimization flag is
substituted for any side of the comparison.

| Artifact label | Compiler bytes | Compiler SHA-256                                                   | Semantic input SHA-256                                             |
| -------------- | -------------: | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| main           |      7,276,611 | `c9d0ea9111bae4edf8944a85cd42cb344263979241b9bb6dfbcd609c90277e82` | `6d16b4b9f71511ad7eef03090908c4870a2f6ca229bedecfa9eb249f8fec6396` |
| demand         |      7,281,581 | `f2e05423007a139c2a98fa5f937437c35e6ae9bf5265172d5c6b370d610e645f` | `ac263057fc1b1216adb9fd425ab5dbb7f76f0877e2b2dbd51d611b86c9962253` |
| sharing        |      7,288,854 | `dcb69ff3e96b8375671061f3b26f338624724fb1fcc9c995e60a6267d37fd3ba` | `e1cad9f699920fccfb382437dabcbb2334bfbe89fd34930adc5dbd5495618d2c` |

`main` is `aea29be47da22636ae232f409bc3ab08b6650d51`, including merged #170.
`demand` matches `20cf793b297a3f65e9e57e637bee7882fbdc8f97`. The sharing
artifact was built from the working source on top of that commit; its semantic
input digest above identifies the measured code. The manifest's source-commit
field records the pre-commit parent, not an invented published commit identity.
The sharing production build passes the original snapshot `--check`; no golden,
ABI schema, or normal CI configuration was changed.

## What the second increment changes

The identity encoder previously retained record sharing but re-expanded
persistent function/range type edges and repeatedly encoded attached signature
roots. The new builder retains those immutable values and their structural
chunks for one synchronous traversal. Equal values still compare structurally;
pointers are only local lookup accelerators with retained owners. A chunk that
introduces a closure definition is not reused as though it were already a stable
closure reference. Portable identity observes the same flattened sequence.

Inherited type and effect substitutions also previously walked complete lexical
ancestries repeatedly. The builder now constructs one combined map for a
demanded frame and shares it with its unchanged empty-frame descendants. A
nearer binding still overrides its ancestor. No snapshot crosses into a later
key construction, where values, signatures, parent edges, and substitutions must
be read again.

A full snapshot is deliberately **not** retained at every nonempty ancestor.
That would create quadratic prefix-map storage for one deep request. The
1,024-frame regression requires only one combined snapshot with 2,048 total
type/effect bindings, rather than all prefix copies. The separate 4,096-empty-
frame test verifies sharing of one unchanged snapshot and owner release.

No subtype rule, ownership meaning, effect identity, runtime capture slot,
residual eligibility condition, or required equality check is removed.

## Diagnostic attribution, not a second latency benchmark

Separate locally instrumented builds compare the first increment with the final
sharing implementation. They emit the same application Wasm and ABI. Their
counters and spans explain eliminated work; instrumentation was not active in
any of the 18 production observations above.

| Diagnostic counter                        | First increment | Sharing increment |
| ----------------------------------------- | --------------: | ----------------: |
| Environment-key constructions             |             338 |               338 |
| Closure visits                            |       2,156,940 |         2,156,940 |
| Capture plans                             |             470 |               470 |
| Instance-specific signature checks        |              30 |                30 |
| Value visits in identity encoding         |      23,917,917 |         8,400,309 |
| Function-type visits                      |       2,559,996 |           132,875 |
| Range-type visits                         |       3,583,021 |           517,729 |
| Lexical frames expanded for substitutions |      11,722,430 |           434,457 |
| Parts examined by key equality            |      32,256,075 |        19,732,103 |

A frame expansion means inspecting an uncached frame's ancestry/substitution
maps; direct cache hits do not expand that frame again. The structural counters
decrease without reducing the number of residual keys, capture plans, or
instance-specific signature checks. This does not claim fewer source-level
computations or justify sharing mutable closure environments across requests.

The measured instrumented key-construction span is 5,155.966 ms before and
3,059.954 ms after; key equality is 515.572 ms before and 473.462 ms after.
These are single diagnostic observations, not production speedup estimates.
Instrumented spans overlap and must not be added. The temporary probes are not
part of the production compiler or the public benchmark harness.

## Validation and rejected exploration

At the measurement commit, the normal production build, unchanged snapshot
freshness, Rust formatting, repository Deno formatting/lint, and **21 focused
identity tests** have passed. Eight of those identity tests are new. They cover
compact type-DAG construction independent of allocation topology, signature
owner retention/release, copy-on-write changes, empty ancestry, the linear
nonempty-chain bound, shadowing and subsequent environment changes, closure
reference stability, and exact flattened portable evidence.

The complete native, abstraction, and regression suites are separate runs. Their
completion and fresh hosted CI results are recorded in the PR discussion on the
published head, not inferred from the earlier green first-increment checks. No
new head is described as passing CI before those checks complete.

An earlier, unpublished variant cached a full substitution map at every frame.
It was rejected for the quadratic prefix-storage risk. A concurrent local
regression attempt on that variant also hit the unchanged 300-second deadline in
the public engine case-study file; its native run was interrupted. Those runs
are **not counted as passes**, and that artifact is not a side of this
production comparison. The timeout's cause was not established independently of
resource contention. Final-source suites run separately with the original checks
and deadlines; no test is excluded to hide that observation.

## Reproduction and remaining target

Use the commands in [README.md](README.md) with each source-built compiler and
its matching snapshot. Retain the same source checkout, process/runtime flags,
artifact hashes, six balanced orders, and every JSON observation. Each harness
invocation must be a fresh process. The generic harness accepts a local entry
point and does not embed the private application.

The earlier syntax/capture-demand experiment remains in
[RESULTS.md](RESULTS.md). Its timings are historical measurements, not extra
samples in this batch. Even after graph sharing, millions of closure visits
remain, and checking plus post-check runtime preparation are still substantial.
An unchanged artifact- cache hit, code-emission-only timer, or relocated work to
initialization would not meet the target of millisecond compilation of an actual
changed program.
