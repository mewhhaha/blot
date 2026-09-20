# Instruction evaluator: implementation and measurement

The slow fixture's median cold compilation fell from **6,695.59 ms to 6,066.48
ms (9.40%)**. This is a useful but modest improvement: the fixture still takes
about six seconds. Its scheduling computation and checked type work remain.

## Implementation

- Rust lazily decodes source expressions into reusable instructions. Function
  binding plans assign invocation-local slots, populated on demand. Dynamic
  `open` scopes keep observed name lookup. Code caches contain no call-specific
  environments, inferred signatures or generated effect identities.
- Ordinary expressions and function returns execute with explicit frames.
  Applications share the existing argument/result-evidence boundary.
  Declarations, handlers and residual construction still use the common semantic
  implementation.
- Small integers use inline i64 storage and promote to shared arbitrary
  precision. Arrays share immutable storage and detach on mutation. Closures
  capture only referenced invocation bindings while retaining inherited scopes
  and evidence; recursive groups retain their original environments. Scalar type
  descriptors and built-in operator tables share immutable storage. Integer
  primitives use operation IDs; other primitive names use shared text.
- Effect histories share immutable prefixes and cache structural hashes.
  Equality still checks structure, and portable capsules encode the ordered
  history. Existing conservative result-cache eligibility and fresh-identity
  rules remain.

## Boundary and inputs

Five fresh Node processes per artifact and fixture, alternating artifact order,
with telemetry disabled. The fixture sources are unchanged
[`prefix.blot`](../cold-semantic/prefix.blot),
[`full.blot`](../cold-semantic/full.blot), and their shared framework.

`coldCompileMs` includes compiler Wasm instantiation, snapshot/source loading,
frontend registration, instruction construction, checking, staging, backend
closure, emission, and copying the emitted Wasm and manifest to the host. It
excludes compiler-file reading, process startup, validation/hashing, subsequent
observation analysis, and session destruction. `compileMs` starts after source
registration. The recorded `analysisMs` in compile samples is a subsequent warm
observation, not a cold-analysis measurement.

Both artifacts consume the **same candidate-generated prelude snapshot** to hold
the graph input constant. The baseline's original distributed snapshot differs;
this is an artifact comparison on fixed inputs, not a comparison of two complete
published distributions. Rust 1.97.1; Node 24.12.0 / V8 13.6.233.17-node.37;
Linux x64; Ryzen 7 7800X3D. Builds and tests were finished before these timing
samples. Other workstation activity was not controlled.

The baseline is the clean artifact at
`aea29be47da22636ae232f409bc3ab08b6650d51`. The candidate is the modified
worktree at that commit. Exact artifact manifests, compiler-input digests, host
details and harness digest are in [`provenance.json`](provenance.json).

## Results

| Fixture / measurement                | Baseline median | Candidate median |                          Change |
| ------------------------------------ | --------------: | ---------------: | ------------------------------: |
| Prefix cold compilation              |       703.30 ms |        699.15 ms | −0.59%, within sample variation |
| Full cold compilation                |     6,695.59 ms |      6,066.48 ms |                          −9.40% |
| Full compilation after registration  |     6,589.42 ms |      5,961.50 ms |                          −9.53% |
| Full Wasm memory after observation   |      132.25 MiB |       133.75 MiB |                       +1.50 MiB |
| Prefix Wasm memory after observation |      45.375 MiB |       47.125 MiB |                      +1.750 MiB |

Full-fixture cold samples span 6,664.81–6,746.15 ms for the baseline and
5,985.51–6,128.51 ms for the candidate. These ranges do not overlap. The smaller
fixture's ranges do overlap. Memory is the compiler's linear-memory size after
the subsequent observation, not process RSS or live retained bytes.

All 20 samples agree on principal type, effects, interface key, target-preflight
result, and **exact emitted Wasm and ABI-manifest hashes**. Full raw samples are
in [`cold-compile.jsonl`](cold-compile.jsonl).

Separate traced cold-analysis samples in [`telemetry.json`](telemetry.json) show
the same 332,118 source closure applications and 65,271 scalar memo hits. The
candidate executes 1,753,050 cached instructions, decodes 4,166 instructions,
and reaches 613 live machine frames. It drives 270,817 semantic callback steps.
The outer trampoline count falls from 2,237,600 to 5,175 because work moved into
the instruction machine; that reduction does not mean source work disappeared.
Single traced timings are attribution evidence, not the speedup measurement.

## Verification

- Native Rust suite: 687 passed, one intentionally ignored.
- Final evaluator checks after cleanup: 40 passed.
- Runtime conformance: all 38 evaluator/emitted-Wasm observations agree.
- Focused host transport, artifact, numeric dispatch, boundary and revision
  tests: 39 passed. Tests that create temporary files ran with `/tmp` write
  access and the temporary-directory environment variables available.
- Rust formatting, library Clippy with warnings denied, TypeScript host
  checking, benchmark formatting and whitespace checks pass.
- Full-target Clippy still reports two existing test-only warnings:
  `items_after_test_module` in `safety.rs` and `collapsible_if` in `session.rs`.

The new tests exercise small-stack execution and provenance destruction, fuel
and source diagnostics, fresh aggregate creation from cached code, capture
retention, tracked namespace demand, shadowing, array alias isolation, integer
promotion, normalization, conversion, arithmetic, and capsule scalar encoding.

Reproduce timing with saved baseline and freshly built candidate artifacts:

```sh
pnpm compiler:build
node experiments/compiler-bench/staged-types/compare.mjs \
  --baseline=/path/to/baseline.wasm \
  --candidate=generated/compiler/compiler.wasm \
  --samples=5 --telemetry=off --operation=compile
```

The original analysis boundary remains the default. Use `--telemetry=on` without
`--operation=compile` for instruction and semantic-work counters. Arbitrary
compile-time source remains subject to its deterministic evaluation budget; this
change does not make expensive source algorithms constant time.
