# Initial staged-core slice: validation and synthetic scaling

## Scope

This implements an isolated pure research compiler, not the complete proposed
language and not an accelerated production `gdev` compiler. The parent is
`506879e8f3d2495c89da5dcaa6e5af99f918dd83` in PR #172. The single-colon
migration and earlier production experiments are retained unchanged.

**These millisecond numbers describe tiny public synthetic programs compiled by
a native Rust prototype. They are not a 100 ms result for the private
application, and are not comparable to the prior Deno/Wasm-hosted production
benchmarks.** The programs deliberately exercise generic body reuse and local
invalidation; they do not cover the missing effects, ownership, arrays,
variants, module system, general recursion, or full type-programming facilities.

## Completed local validation

The final isolated `cargo test --locked` command passes **48 tests** with no
failures or ignored tests: **35 new staged-core regressions** and **13 tests of
the shared existing frontend**. The new cases exercise inference/generalization,
open rows, computed schemas, closed typed code, explicit phase boundaries,
actual static dependencies through memo hits, generativity, source/failure
classification, graph work bounds, retained storage, and real edits.

The release executable passes the Node execution driver: **24 process
invocations**, fresh/edited output and diagnostic comparisons, valid generated
Wasm, and **100,000 repeated scalar export calls** without accumulating
temporary closure/aggregate storage. Host calls test distinct captures,
shadowing, function/global relocation after insertion/deletion, record order,
Type/Code bridge rejection, wrapping arithmetic, Boolean boundary validation,
and agreement of a static computation with emitted execution.

Native all-target Clippy and Wasm-target library Clippy pass with warnings
denied. Both manifest formatting checks, repository Deno formatting/lint,
source-derived inventory freshness, normal production build, and the unchanged
original prelude snapshot `--check` pass. The shared frontend imports in the
research crate alone allow unused internal APIs; the experimental semantic core
has no lint exemption. No production source, Cargo setting, workflow, threshold,
or deadline is changed by this implementation increment. An additional prototype
workflow runs its independent tests, build, lint and emitted execution.

Hosted results on the published head belong in the PR's current status. Local
results and previous-head hosted checks are not substitutes for final-head CI.

## Public synthetic measurements

`measure.mjs` generates 16, 64 or 128 distinct arithmetic callers of one
inferred polymorphic identity function. It then changes exactly one caller's
constant. All other bodies are unchanged. Every exported function is executed at
three inputs before the edit, after the edit, and in an independent fresh
compilation of the changed source.

| Caller bodies | Source bytes | Cold median | Edited median | Independent fresh-edited median |
| ------------- | -----------: | ----------: | ------------: | ------------------------------: |
| 16            |          904 |    1.150 ms |      0.940 ms |                        1.087 ms |
| 64            |        3,640 |    3.975 ms |      3.223 ms |                        4.258 ms |
| 128           |        7,400 |    7.939 ms |      6.427 ms |                        8.242 ms |

There are four samples at each size: **12 unedited JSONL records**, representing
36 full compiler requests in 24 native processes. Each record contains cold,
real-edited and independent fresh-edited observations. Sizes run in ascending
order. There are no discarded observations. Verification ran before the batch;
operating-system/file caches were not flushed. No other local build, test or
profiler ran during measurement. Each child has a 30-second parent-enforced
deadline, never reached. This small shared-host batch is not a confidence bound.

Every edited request checks **one** named definition, reuses all other named
interfaces, executes **zero** static calls, and creates **one** new
core-function fragment. The 128-caller case emits 130 core-function bodies cold
(128 callers, identity, addition), then reuses 129 of them after the edit. The
generator demo is a separate correctness fixture: its runtime edit checks one
definition, reuses eight, makes no static calls, and reuses seven of eight
function fragments.

Edited time still grows with source size because the prototype reparses the
whole source, validates dependencies, checks export expressions, rebuilds global
initialization, resolves relocations, assembles the module and validates Wasm.
It does **not** claim a constant-time edited build. Work counters distinguish
named definitions and core fragments from those remaining stages. Reported
charged storage is retained payload/cache accounting, not peak memory or RSS.

All generated modules validate; emitted execution agrees with fresh compilation
of the changed source. No private source, executable, ABI contents or profile is
included. `samples.jsonl` retains every observation, including source and binary
hashes; `measure.mjs` reproduces the inputs.

## Reproduction and identity

```sh
cargo build --locked --release \
  --manifest-path experiments/staged-core/native/Cargo.toml --bin staged-prototype
node experiments/staged-core/verify.mjs \
  experiments/staged-core/native/target/release/staged-prototype
node experiments/staged-core/measure.mjs \
  experiments/staged-core/native/target/release/staged-prototype
```

Rust 1.97.1 (`8bab26f4f`, 2026-07-14), Linux x86-64, AMD EPYC 9V74 host,
four-CPU quota, 4 GiB memory limit. The native release profile uses size
optimization, fat LTO and one codegen unit. Node 22.16.0 launches the processes
and separately validates/executes their Wasm; it does not host the compiler.
Compilation includes parsing, checking, static execution, invalidation,
lowering, assembly and Wasm validation. Initialization is separately timed.
Filesystem reads/writes and printing are outside that interval; process wall
measurements include both original and edited requests in their process.

- Measured native compiler SHA-256:
  `42f8bac26e0c969ac883005f8bf3cecd7fe712d24977967ee55f481dc3a4f38f`.
- Research-source/input SHA-256:
  `339aa666635a1872b73490a873cec82276f4d6666ffc723e5344c9218d71d934`.
- Unchanged production snapshot SHA-256:
  `2a7a7348e2e3565b3e8f037428f7e7347795334d1bacd31c79f02c8cffe925ae`.

The source digest concatenates sorted relative paths, a NUL, their bytes and a
NUL for `compiler/src/staged/*.rs`, `experiments/staged-core/native/src/*.rs`,
the research Cargo manifest/lock, and these exact shared `compiler/src/*.rs`
files: `artifact_limits`, `ast`, `cst`, `diagnostic`, `fixity`, `frontend`,
`frontend_plan`, `layout`, `lower`, `rebinding`, `source`. It does not
substitute an invented published commit identity for a binary built before
publication.

## Rejected integration and corrected early tests

An initial feature/shared-package integration added an `rlib` alongside the
production `cdylib`. Its normal production snapshot check changed. That
integration was rejected, not repaired by rewriting the golden. The final
standalone research crate imports the exact frontend files by path and leaves
production Cargo and `lib.rs` byte-identical to the parent. The normal
production build now reproduces the original snapshot successfully.

Before isolation, combined native runs passed 757 and then 758 tests, with the
one pre-existing diagnostic benchmark ignored. Those are not extra unique tests
or an isolated-final-crate result. The final independent command passes the 48
tests reported above. Early fixture failures used incorrect surface syntax and
were corrected to Baba's actual `do`/`if` syntax. A schema work test initially
forgot that each layer stores both a row and a record; it now asserts exactly
two additional type nodes per layer against a zero-layer control.

Earlier debug/shared-package execution observations are not included in the
latency table. No result here validates the complete staged proposal or closes
the private application's remaining latency gap.
