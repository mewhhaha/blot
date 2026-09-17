# Demand-driven evaluator type evidence: incremental PR #170 result

## Status and scope

This follow-up has a measured within-batch improvement over the existing PR #170
implementation, not a completed whole-type-system rewrite. With telemetry off,
the full-fixture median falls from 20,179.157 ms to 17,706.759 ms (-12.25%).
Prefix falls from 1,898.100 ms to 1,721.993 ms (-9.28%). The full fixture still
requires about 17.7 seconds at this boundary on this host.

These comparisons are against PR #170, not `main`, and not against the absolute
times in `RESULTS.md`, which were measured in another batch/on another host.
Keep the earlier negative result as historical evidence. This increment reduces
per-evaluation overhead; it does not reduce source-level staged closure fan-out.

PR #170 was already open as a draft on `perf/staged-type-system`. This increment
was implemented, committed, and validated locally. The available connection
exposed repository reads but no publishing action, and the local environment
could not reach GitHub for a push. No new commit or CI result is claimed on the
remote PR. A two-commit mail patch carries this implementation and its evidence.

## Why this change targets the measured bottleneck

`../cold-semantic/T2_ATTRIBUTION.md` attributes 83.4% of its historical
full-minus-prefix slowdown to evaluator work during semantic preparation. That
is not a claim that 83.4% of every compilation is comptime. The study identifies
repeated world/schedule execution, rather than the subtype solver alone, as the
dominant source of the fixture's scaling cost.

The previous evaluator queried and substituted an expression's checked type on
every visit, including expressions whose concrete evaluation never consumed it.
It also appended a representation-recording continuation to every successful
expression, even when there was no residual trace or no type to record.

`evaluate_expression` now demands that representation only for numeric literals,
array materialization, case result evidence, or residual tracing. The
independent application result-context and closure-signature lookups remain.
When there is nothing to record, the evaluator returns the original computation
with its diagnostic origin, instead of allocating a no-op continuation.

No memoization eligibility rule changes. No environment-dependent specialization
result, closure result, or fresh effect/region/quantifier identity is newly
shared. The existing structural records, unions, refinements, first-class type
values, higher-order functions, explicit polymorphism, effects and ownership
rules remain. The subtype solver and parser are unchanged. The corresponding
staging/evidence contract is updated in `spec/STAGING.md`.

## Measurement boundary and provenance

The comparison ran from `2026-09-17T12:32:30Z` to `2026-09-17T12:39:56Z`. Each
of the two telemetry modes contains five samples for each artifact/fixture: 40
fresh Node processes in total. Artifact order alternates by iteration. All
samples are retained in `demand-off.jsonl` and `demand-on.jsonl`; none was
removed or selected after observing its timing. Telemetry-off is the primary
wall-time result; the later telemetry-on batch is a counter/control measurement,
not an order-randomized estimate of telemetry overhead.

No local Rust build, native suite, or abstraction suite overlapped these
batches. The host is a shared container, not a dedicated benchmark machine; five
samples do not establish a universal speedup or a general statistical guarantee.
Earlier smoke tests were functional checks, not members of these batches.

The timer encloses semantic analysis, fact materialization and target preflight.
It excludes Wasm instantiation, source registration, snapshot installation,
final executable emission and executable runtime. This is not full CLI startup
or an end-to-end build-time measurement. Every sample checks the principal type,
empty effect row and supported target preflight. The driver additionally rejects
cross-artifact differences in input hashes, interface keys or these results. A
post-run check also compares them across telemetry modes.

Baseline semantic source: `44f607e37f2e29468be858c13c3e02ff807981b7`. The later
upstream head `46f5067c46a8a74c10a32379db3e3d22ea75737a` adds only the previous
`RESULTS.md`. Every file modified by the code patch was independently checked
against its GitHub blob identity at that head; all four match the local patch
base. The local semantic implementation commit is
`32dc8cb1f2201d76999ce0ac7e620a1a6f654ca4`; later changes add
results/documentation only. Compiler source digests were checked again after
validation.

Both artifacts were rebuilt with pinned Rust 1.97.1 and the same bare Cargo
release profile: `opt-level = "s"`, fat LTO, one codegen unit, panic abort,
stripping. They are **not** claimed to be normal-distribution build-script
artifacts: that script adds linker flags not used here. No compiler binary or
toolchain is included in the patch.

Host: v22.16.0, linux x64, Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz. The
container memory limit is 4 GiB.

```text
baseline  84ca7fb93149d49fd3280a8d8e2e3e06abdb0967f14788798da3a56c29a95813  7276284 bytes
candidate 55c7d940e345f2d5ff9f79216678668c9e489e2bf15a1a3e685b3f6f73c048cf  7276337 bytes
```

Input SHA-256:

```text
prelude    257f18f8fbcd0b7d7c991d0f6cf6af4f51e0c1f5b7704fb11e99845848e1064f
snapshot   87718708480be1ebe78c1c6cff3944c8e78cafce48157495dad3c780df7bd57f
framework  18b5829343fa977c0cea93834352d9b3e418f321a080cc069c68e57fbfe04e15
full       8ec9d28a1c8c6b9bd4a345881e91a0c2c6b55f147f5e535d217459289d324054
prefix     009d4e05d86b3b437f036ee7573656506bc72141186c9f58214079908faa168e
```

## Results

Times are milliseconds; each cell is a median of five fresh-process samples. The
change is candidate / baseline minus one.

| Telemetry | Fixture | PR #170 baseline | Candidate | Change |
| --- | --- | ---: | ---: | ---: |
| off | prefix | 1,898.100 | 1,721.993 | -9.28% |
| off | full | 20,179.157 | 17,706.759 | -12.25% |
| on | prefix | 1,817.952 | 1,804.063 | -0.76% |
| on | full | 20,259.033 | 17,176.681 | -15.21% |

Complete analysis-time vectors in iteration order, not sorted:

```text
mode fixture artifact  iteration0 iteration1 iteration2 iteration3 iteration4
off prefix baseline  1758.574 1980.321 1898.100 1768.197 1911.130
off prefix candidate 1721.993 1808.044 1672.732 1716.349 1747.949
off full   baseline  20179.157 19466.848 19470.834 20189.284 20766.571
off full   candidate 17324.959 17706.759 16773.535 17968.271 18243.197
on  prefix baseline  1783.666 1786.781 1863.334 1817.952 1916.340
on  prefix candidate 1807.275 2032.538 1797.218 1702.887 1804.063
on  full   baseline  20947.506 19264.213 20243.221 20259.033 20276.493
on  full   candidate 18924.695 17176.681 17313.823 17039.167 16931.399
```

Full-fixture semantic-preparation evaluator medians with telemetry on are
14,725.388 ms baseline and 11,955.602 ms candidate. Do not sum overlapping
preflight evaluation spans into the sequential phase totals.

The following counters are deterministic across all five telemetry-on samples:

| Fixture | Baseline transitions | Candidate transitions | Baseline closure applications | Candidate closure applications |
| --- | ---: | ---: | ---: | ---: |
| prefix | 71,055 | 38,202 | 5,282 | 5,282 |
| full | 4,014,502 | 2,237,600 | 332,118 | 332,118 |

`eval.steps` counts interpreter/trampoline transitions, not source expressions.
The lower transition count does not imply fewer staged closure executions or
better source-program asymptotic complexity. Source-expression fuel remains
charged in `evaluate_expression`; administrative continuations do not consume
it. Real continuation boundaries, evaluation order and source diagnostics
remain.

All 40 samples return `{ .run = Int -> Int }`, an empty effect row,
`function-payload-components:{.run:(Int->Int~pure)}~pure`, and supported target
preflight. Raw telemetry also records structural counters; this result does not
claim all compiler-work counters are unchanged.

Wasm allocated linear memory at analysis completion, in bytes (distinct values
observed in each group):

| Telemetry | Fixture | Baseline | Candidate |
| --- | --- | ---: | ---: |
| off | prefix | 40239104 | 40239104 |
| off | full | 117374976 | 117112832 |
| on | prefix | 40370176 | 40370176 |
| on | full | 117440512 | 117374976 |

These are not process RSS, peak live heap or allocation-volume measurements.

## Correctness validation

- All 669 native library tests passed; zero failed and none filtered out. The
  existing diagnostic benchmark remains the one intentionally ignored test.
- All 37 registered abstraction suites completed in one uninterrupted harness
  invocation: 177 tests passed, zero failed, zero skipped. The harness and its
  per-file deadline were not modified. Its existing checks include principal
  types, source rejections, evaluator output and independently emitted Wasm.
- Six added deterministic regressions cover omitted leaf resolver demand,
  absence of an added leaf trampoline step, preserved numeric domains, residual
  recording continuation demand, absent residual evidence, exact diagnostic
  origin/span, and source-fuel ordering.
- Rust formatting, `git diff --check`, Wasm-target Clippy with warnings denied,
  and both release-Wasm builds passed. The comparison driver passes Node syntax
  checking and rejects an invalid telemetry setting.

The first native attempt overlapped compiler builds and was killed under the
container memory limit. The complete suite was rerun serially after those builds
finished; the 669-pass result is that uninterrupted rerun, not an aggregate of
partial runs. A large snapshot-buffer assertion also exhausted memory while
formatting a mismatch; bounded equality/hash checks replaced that diagnostic. No
source test was skipped to obtain a pass.

### Distribution snapshot limitation

Both rebuilt artifacts regenerate an identical prelude snapshot: 536,293 bytes,
SHA-256 `d5d8b7685fc634c3830fd10655f524b609e4621486a7cdeab11e3a699b5324a7`. That
does **not** match the unchanged distributed snapshot (536,335 bytes, SHA-256
`87718708480be1ebe78c1c6cff3944c8e78cafce48157495dad3c780df7bd57f`). The
discrepancy occurs in the rebuilt baseline as well as the candidate; it is not a
candidate-only drift. Its root cause is not established. No claim is made that
normal build-script snapshot-freshness validation passes.

The tests and comparison use the same unchanged distributed snapshot input for
both versions. The local candidate artifact manifest records its actual Wasm,
compiler-input and snapshot hashes using the repository's identity functions.
This does not replace a normal distribution build/freshness check. Deno and new
hosted CI results are unavailable in this environment and are not claimed.

## Reproduction

Create separate checkouts of the PR baseline and the patched branch, each with
the repository's pinned toolchain. Build both with the same settings:

```sh
cargo build --locked --manifest-path compiler/Cargo.toml \
  --release --target wasm32-unknown-unknown
```

Copy each resulting
`compiler/target/wasm32-unknown-unknown/release/blot_compiler.wasm` to a
separate path. From the patched checkout, with identical fixtures and the same
tracked prelude snapshot:

```sh
node experiments/compiler-bench/staged-types/compare.mjs \
  --baseline=/path/baseline.wasm --candidate=/path/candidate.wasm \
  --samples=5 --telemetry=off > demand-off.jsonl
node experiments/compiler-bench/staged-types/compare.mjs \
  --baseline=/path/baseline.wasm --candidate=/path/candidate.wasm \
  --samples=5 --telemetry=on > demand-on.jsonl

CARGO_PROFILE_TEST_OPT_LEVEL=1 CARGO_PROFILE_TEST_DEBUG=0 \
  cargo test --locked --manifest-path compiler/Cargo.toml --lib \
  -- --test-threads=1
cargo clippy --locked --manifest-path compiler/Cargo.toml \
  --target wasm32-unknown-unknown -- -D warnings
```

The local builds/tests used `--offline` with previously supplied pinned Cargo
inputs. That flag is optional for a normal checkout with registry access. Full
Node qualification requires the matching compiler artifact and its generated
manifest, then `node scripts/check_abstractions.mjs`.

## Remaining architectural work

The type-graph/selective-instantiation work in PR #170 and this demand-driven
evaluator increment still execute the same staged source closures for each
world/schedule combination. A larger redesign must reduce that repeated work or
its remaining execution cost while preserving environment dependencies, required
type evidence and fresh identities. This patch does not establish that an
arbitrary first-class type builder is safe to memoize, and it does not justify
weakening the abstraction contracts to obtain a faster number.
