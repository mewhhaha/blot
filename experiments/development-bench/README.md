# Development rebuild benchmark

This benchmark measures a file edit through committed runtime activation on a
generated 5 MiB project with 20 reachable units. Source volume comes from Blot
voxel records and functions, not comments. The entry calls every unit, so the
initial build prepares the whole project. Catalog declarations are distributed
among the 18 unchanged content units; each edit changes the small gameplay
provider without changing its interface.

Each of 20 warm samples writes the provider, marks the file changed, builds the
delta, compiles and instantiates the changed Wasm unit, commits it to the active
runtime, and checks the exported result. A sample fails if any other unit is
emitted. The run fails when edit-through-activation p95 is 100 ms or greater. It
also fails when maximum resident-memory growth after the initial activation is
128 MiB or greater; a development session must reuse transient compiler storage
instead of retaining one compilation's working set per edit. The committed and
activation clocks stop, and RSS is captured, immediately when transactional
activation resolves. Changed-unit classification is part of the build and
committed clocks. The assertion that exactly one unit changed and the mandatory
runtime observation happen after the clocks and RSS sample.

```bash
pnpm benchmark:development
```

Schema 3 retains every raw sample, build and activation durations, transferred
bytes, changed and retained units, RSS, and maximum RSS growth. Its provenance
names the repository commit and a content identity for every tracked or
non-ignored untracked worktree file, including missing markers for tracked
deletions. A second identity covers the complete measured host harness: this
experiment, the TypeScript host, every file in Deno's resolved module graph
including installed dependency bytes, generated parser inputs, package
resolution inputs, and the compiler distribution. The report also records the
compiler artifact, manifest, compiler-input, prelude, source commit/tree, and
Rust toolchain identities; Deno/V8 versions; exact Deno executable and
invocation identities; and platform, architecture, CPU models, and logical CPU
count. Provenance is captured before and after the warm samples, and any drift
rejects the run.

`compilerProfile` comes from the selected artifact's adjacent manifest. The
production command validates
`generated/compiler/{compiler.wasm,
compiler-artifact.json,prelude.snapshot}`;
the profile command validates the corresponding files under
`compiler/target/development-profile/`. Those exact validated Wasm and snapshot
bytes are passed to the project, so a profile run cannot inherit production
provenance.

Exact Deno invocation attestation currently requires Linux procfs. Every build
also observes the compiler's optional development memory profile. Its absence is
reported as the production feature status; when present, the report marks the
`development-profile` feature and retains every initial and sample checkpoint.
Solver checkpoints retain their cardinality measurements. Mixed observations or
a mismatch with the manifest profile reject the run. `--report-only` disables
the latency and memory gates; it does not enable compiler profiling. Use it
while profiling a known regression, and use `--output=path` to retain a report.

Build and run the profiled compiler without replacing the production compiler
distribution:

```bash
pnpm compiler:build-development-profile
pnpm benchmark:development-profile -- --output=/tmp/blot-development-profile.json
```

The report stores the stage samples under `compilerProfiling.initialCheckpoints`
and `compilerProfiling.sampleCheckpoints`. `pages` is the Wasm memory size at
that checkpoint, measured in 64 KiB pages. It is a high-water observation, not a
live-allocation count. Native builds report zero pages. Only `solver-start`,
`semantic-request`, and `checked-entry` carry the optional `solver` cardinality;
the remaining checkpoints isolate Runtime HIR, program splitting, unit identity,
and backend emission. A committed unit outside the checked impact cone reports
`unit:<name>:unaffected` and has no identity or artifact-construction checkpoint
when its function/link partition is also unchanged; the splitter traced its
calls and reload edges but did not materialize the unit module. The production
artifact omits this instrumentation and reports
`compilerProfiling.featureStatus` as `production`.

This workload does not cover interface edits or demand changes. Those require
separate scenarios because they intentionally change the consumer closure.

`pnpm benchmark:development-active` compares active call graphs: 10, 20, and 40
providers plus their entry unit, with 32 reachable helpers per provider, Int/F32
generic applications, and runtime recursion. Pass provider counts as positional
arguments for a smaller run. For each count, separate processes measure
cache-disabled, memory, and disk modes at the same source paths, each with
initial activation and 20 provider edits. A fourth process restarts the disk
project at the final saved revision. Every activation verifies integer and float
results, and every warm edit must transfer only its provider, including when a
constant grows from `9` to `10`. The JSON report includes the same artifact and
harness provenance as the catalog benchmark, raw startup/build/commit timings,
memory, cache observations, and Rust work counters. Disk writes are included in
build timings. Do not edit measured inputs during a run: provenance drift
rejects the report. This comparison reports latency without imposing a speed
threshold.

`work.specializedFunctions` counts residual call bodies actually specialized by
source module, excluding export wrappers and calls resolved entirely at compile
time. `work.reusedFunctions` counts bodies restored from scalar graph memos, and
`work.emittedUnits` counts emitter invocations. A retained Wasm unit can still
have nonzero specialization work; an unchanged closed-program request reports
zero for all three. Disk restart restores graph memos, then checks source and
emits all initial units. Compare elapsed timings as well as the skipped work.

On 2026-09-08, artifact
`6944c7882b0fb242c57800242a6d293e93374bdbd0c65d69fcedce6196c5412f` produced
these committed warm-edit medians on a Ryzen 7 7800X3D with Deno 2.9.6:

| Providers | Cache disabled | Memory cache | Disk cache |
| --------- | -------------- | ------------ | ---------- |
| 10        | 325.4 ms       | 283.6 ms     | 317.0 ms   |
| 20        | 799.7 ms       | 606.6 ms     | 563.7 ms   |
| 40        | 1309.2 ms      | 837.8 ms     | 903.1 ms   |

At 40 providers, each warm edit specialized 37 bodies and restored 1,443;
disabled caching specialized all 1,480. Every edit transferred only its
provider. Disk restart restored all 1,480 bodies and still checked source and
emitted the 41 initial units. Its build took 1953.5 ms plus 144.1 ms startup.
Populating a cold cache costs extra: the initial disk build took 3395.2 ms
versus 2599.8 ms with caching disabled. These are observations from one paired
run, not latency guarantees; the small ten-provider disk improvement is within
ordinary noise.

On 2026-09-01, the production artifact identified by SHA-256
`aacb245e0d3f3c6cbe1984fb7d4e6b3bf8ed83826c4199758a78da694d586b21` compiled the
5,273,553-byte workload at 81.3 ms committed p50 and 90.7 ms p95. Only the
edited unit was transferred; maximum post-activation RSS growth was 6,660,096
bytes. The first warm sample was the 319.6 ms maximum and does not enter the
nearest-rank p95 for 20 samples.
