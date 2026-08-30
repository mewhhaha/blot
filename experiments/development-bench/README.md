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
and backend emission. The production artifact omits this instrumentation and
reports `compilerProfiling.featureStatus` as `production`.

This workload does not cover interface edits or demand changes. Those require
separate scenarios because they intentionally change the consumer closure.
