# Full-compilation demand results

## Scope and verdict

A real private application was compiled to its final executable, in a fresh Deno
process and compiler session for every observation. This is not an analysis-only
benchmark, a preparation-only timer, or an artifact-cache hit.

The measured median decreased from **14,232.063 ms** to **12,811.978 ms**, a
**9.98% reduction**. All five candidate observations were below all five
baseline observations in this batch. The target of millisecond compilation is
**not achieved**. Five samples on a shared host are not a confidence interval or
a portable speedup guarantee. This increment removes avoidable syntax analysis
and optional capture work; it does not redesign the remaining staged
computation.

## Paired observations

| Artifact  | Samples |       Minimum |        Median |       Maximum | Median initialization |
| --------- | ------: | ------------: | ------------: | ------------: | --------------------: |
| Baseline  |       5 | 13,724.219 ms | 14,232.063 ms | 14,962.319 ms |            150.627 ms |
| Candidate |       5 | 12,198.715 ms | 12,811.978 ms | 13,560.151 ms |            140.970 ms |

[samples.jsonl](samples.jsonl) retains all ten observations. Order alternated
baseline/candidate, candidate/baseline, and so on. No sample was discarded.
There were no concurrent local builds, tests, or profilers. A parent process
imposed a 90-second limit; no timed observation hit that limit.

The timer starts after `Compiler.create` and ends after `Compiler.compile`
returns the final Wasm and ABI. Initialization is separately reported. Input
hashing, Wasm validation, and optional output writes are outside that timer.
`processWallMs` additionally includes script startup, artifact reads,
validation, input hashing, and teardown; it is not the compiler interval.

The host was an AMD EPYC 9V74 Linux x86-64 environment with a four-CPU quota and
a 4 GiB memory limit. The workload uses Deno; both artifacts were tested with
Deno 2.9.7 / V8 15.0.245.2-rusty and default tiering, not mixed with Node
samples or experimental Wasm compilation flags. Deno's Node-compatibility
version also appears in `runtimeVersions`; it does not mean these samples ran
under Node.

## Identity and correctness at the measured boundary

Every sample reports `artifactSource: "compiled"` and `wasmValidated: true`.
There are 10 observed input files totaling 162,451 bytes. The observed input
closure is identical across all ten samples. The digest includes absolute paths
and is for this checkout, not for a relocated one.

- Input closure SHA-256:
  `ae9dc3c5b200c0b0c47b42f0418c67e68639ccb3d8e2964b9bd622abac40e229`.
- Emitted Wasm: **1,479,175 bytes**, SHA-256
  `9f4e408e8cc492b8285538bcbf50e631d73387fec8b11d57995ec129ef9f650a`.
- Emitted ABI SHA-256:
  `cbfbbf3de03af065b1f89eafcacc3d6897248e2603b8e04d0b3c6715127ff1a0`.

**Both emitted artifacts are byte-identical in every baseline and candidate
sample.** This confirms the same output for this workload; it is not a claim
that one workload proves every language feature correct. Application source,
Wasm, and ABI contents are deliberately not committed to this public repository.

## Build provenance

The baseline semantic source is main `aea29be47da22636ae232f409bc3ab08b6650d51`,
equivalently the note-only PR head `80032f3fbae62a2f2b40151998d2dbcf5778d617`.
Both artifacts were rebuilt locally with pinned Rust 1.97.1, the same locked
vendored dependencies, and the normal `scripts/build_compiler.ts` production
profile: size optimization, fat LTO, one codegen unit, and the normal 8 MiB Wasm
stack. No bare-Cargo diagnostic artifact is substituted for one side.

| Artifact  | Compiler SHA-256                                                   | Semantic input SHA-256                                             |
| --------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Baseline  | `c9d0ea9111bae4edf8944a85cd42cb344263979241b9bb6dfbcd609c90277e82` | `6d16b4b9f71511ad7eef03090908c4870a2f6ca229bedecfa9eb249f8fec6396` |
| Candidate | `f2e05423007a139c2a98fa5f937437c35e6ae9bf5265172d5c6b370d610e645f` | `ac263057fc1b1216adb9fd425ab5dbb7f76f0877e2b2dbd51d611b86c9962253` |

The **existing prelude snapshot is unchanged**, SHA-256
`87718708480be1ebe78c1c6cff3944c8e78cafce48157495dad3c780df7bd57f`. Normal
snapshot export and `--check` both pass with the candidate. No snapshot schema
or public ABI changes.

An exploratory hash-table version of the free-name cache perturbed serialized
internal prelude type evidence. It was not used for this comparison. The final
per-module cache uses an ordered map and preserves the complete existing
snapshot byte-for-byte. The unchanged syntax and value capsule were checked
during that investigation; internal inference differences were not dismissed as
merely cosmetic or accepted by weakening freshness checks.

The artifact manifests were produced from working trees: their source-commit
fields identify the note-only base, while their semantic-input digests identify
the actual measured code. The candidate source digest above, not an invented
pre-publication commit SHA, is the measurement identity.

## Initial diagnostic observations, not additional paired samples

Before rebuilding the local pair, a supplied production compiler artifact took
18,247.385 ms for a full compilation on this host, plus 203.937 ms
initialization. A separate fresh split-mode run spent 20,469.191 ms in
`prepare`, then 146.785 ms in `compile`. Preparation includes checking, staging,
specialization, runtime-HIR construction and validation, plus the host's HIR
copy; it is not just parsing or type inference. These single observations
establish the useful investigation boundary, not a speedup against the final
candidate. Do not divide them by the paired candidate numbers.

The supplied executable contains 1,034 defined functions, 1,337,229 code-section
bytes, and 3,056 exact duplicate function-body bytes in a 1,479,172-byte module.
That rules out exact binary deduplication as a sufficient explanation for the
latency. It does not rule out excessive specialization or structurally similar
code that is not byte-identical.

## Validation status at publication

The production build, unchanged prelude-snapshot freshness, benchmark option
tests, and the ten full-application compilations pass. Seven new native tests
cover syntax-cache identity and invalidation, current capture evidence, and the
early staging decision. The first complete native run passed 685 tests with the
pre-existing diagnostic benchmark ignored; that run preceded the final ordered
map and borrowed-name refinements. A fresh native run and standard hosted CI
must validate the final published source; their completion is recorded in the PR
discussion rather than retroactively attributed to the earlier run.

No test was removed, no timeout or performance threshold was raised, and no
standard CI workflow was changed. The staging contract and generated language
inventory are updated with the source change.
