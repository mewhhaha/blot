# Package T1: guest-side wall timing + phase telemetry schema 2

Follow-up to the Package-A3 NO-GO (guest phases had no wall timing:
`clock: null`, all counters in one `semantic-preparation` bucket, H2/H3/H4
undistinguished). This package adds a host-imported guest clock, nested
sub-phase wall spans, and eval/structural counters. No algorithmic or
semantic changes: every hook is observation-only, and untraced calls keep
their exact behavior (one predictable branch per hook when idle).

## Clock

- Wasm guest reads `blot.now_ms`, imported from module `blot`, served by
  `performance.now()` in `src/compiler/wasm.ts` (`CompilerWasm.instantiate`
  always passes the import; extra imports are ignored by artifacts that do
  not declare it, so pre-T1 artifacts keep loading under the new host).
- Native builds (cargo tests, profiling drivers) fall back to a
  process-epoch `Instant`; the payload always names the active clock.
- No host ABI bump: the import is additive, and the TS types accept both
  schema 1 (`clock: null`) and schema 2 (`clock: string`).

## Schema (guest `phaseTelemetry.schema = 2`)

Per phase: `milliseconds` (guest wall) + `subSpans` + existing
`workDelta`/`counterResets`. Checker phases carry
`eval / conversion / coverage / ownership / safety / other`; preflight
carries `re-prepare / check / hir-elaborate / backend-close / other`.

New top-level sections `eval` and `structural`:

- `eval`: Checker-level `expressionCalls`/`bindingCalls`, exact
  `cacheHits` (`evaluated_bindings`), lossy `uniqueInputs` (FNV over
  module, pattern/expression, phase, bounded environment walk — a lower
  bound, never proof of equality) with `hotExpressions` top-8,
  `runs`/`steps` (outermost `run()` wall attribution; every drive-loop
  iteration counted once), `closureApplications`/`moduleApplications`,
  exact comptime-memo outcomes using the evaluator's own keys
  (`memoEligible/Probes/Hits/Stores/StoreDroppedAtLimit/
  NonmemoizableResults/UniqueMax`), conversion call splits
  (`conversionCalls`, inside vs outside eval), module-template
  `templateHits`, and reconstruction outcomes
  (`reconstructionsAdmitted/DecodedOk/DecodedErr/FallbackFullEval`).
- `structural`: `internHits`/`internMisses` (splits existing
  `typeInterns`), `sameTypeCalls`, `coverageCalls`, `ownershipCalls`,
  `safetyCalls`.

Charge-once rules (see `spanSemantics` in the payload and the
`phase_telemetry` module docs): phase walls are sequential and sum to the
request wall; `other` is phase wall minus disjoint children (inference and
biunification live there); `conversion.insideEvalMs` overlaps `eval` and
must never be summed with it; preflight `evalMsWithinPreflight` is
informational overlap with that phase's sequential spans.

## Flags and output wiring

- No new flags: `--telemetry=off|phase` (both `sample.ts` and `run.ts`).
  `phase` enables host spans + full guest schema 2. Canonical batches stay
  `--telemetry=off` (`phaseTelemetry: null`, guest untouched).
- `sample.ts`: unchanged — it already forwards `phaseTelemetry`
  (`{host, rust}`) opaquely, so the schema-2 payload flows into `raw.jsonl`
  with no sample-schema bump (verified: `clock` string, `milliseconds`,
  `subSpans`, `eval`, `structural` all present in T1 samples).
- `run.ts`: additive per-fixture `telemetrySummary` in `summary.json`
  (run schema stays 1): `guestPhaseMs`/`subSpanMs` distributions,
  `conversionInsideEvalMs` (overlap), median `eval`/`structural` counters,
  and derived `guestUnattributedMs` (host guest-call minus guest phase
  walls = response serialization + telemetry attach + call overhead).
  Null for `--telemetry=off` batches.

## Files changed

- NEW `compiler/src/phase_telemetry.rs`: clock, thread-local collector
  (guard-bound; nested activation shares the outer collector), span guards
  with reentrancy depths, input fingerprints, snapshot.
- `compiler/src/lib.rs`: `mod phase_telemetry;`.
- `compiler/src/eval.rs`: `run()` enter/exit + step counting (loop
  behavior identical); closure/module application counts; comptime-memo
  probe/hit/store/len notes (store logic identical); module-template hit
  and reconstruction admit/decode/fallback notes.
- `compiler/src/typecheck.rs`: Checker eval entry notes (+ cache hits);
  conversion/coverage/ownership/safety span guards; interner hit/miss and
  `same_type` call notes; `phase_tag` helper.
- `compiler/src/session.rs`: wall spans + sub-spans per phase, preflight
  sub-spans via shared `close_program_inner` (the `None` path is the
  historical `close_program`), schema-2 `attach`, extended traced-analysis
  test (schema/clock/walls/charge-once/counter presence).
- `src/compiler/wasm.ts`: `blot.now_ms` import + schema-2 types
  (`CompilerRustSubSpan`, `CompilerEvalTelemetry`,
  `CompilerStructuralTelemetry`; `clock: string | null`, optional
  `milliseconds`/`subSpans` for schema-1 artifacts).
- `src/compiler/session.ts`, `src/compiler.ts`: re-export new types.
- `src/compiler/session.test.ts`: schema-2 assertions (clock, walls,
  sub-span names, guest-vs-host cross-check, eval/structural presence).
- `experiments/compiler-bench/cold-semantic/run.ts`: `telemetrySummary`.
- NEW `experiments/compiler-bench/cold-semantic/telemetry_t1/` (phase
  verification batch, 2x prefix+full) and `telemetry_t1_off/` (off-path
  null check); this file.

## Separation evidence (batch `telemetry_t1`, artifact 30d81f097484…,
prelude dd980347acb0…, provenance stable)

Prefix (analyze p50 739.0ms): prep 540.5ms =
eval 95.6 + conversion 5.1 + coverage 1.3 + ownership 14.6 + safety 8.5 +
other 415.1; preflight 35.4 (hir-elaborate 25.6, re-prepare 8.0).
Full (analyze p50 8087.9ms): prep 7591.8ms =
eval 6234.6 + conversion 12.6 + coverage 2.5 + ownership 15.8 + safety 8.9 +
other 1315.7; preflight 269.9 (hir-elaborate 246.6, re-prepare 19.2).
No `clock: null`, no all-in-one bucket: eval is 82% of full-prep vs 18% of
prefix-prep; steps grow 74k -> 4.86M (66x), closure applications
5.3k -> 401k (76x), memo 677/2704 -> 76230/185494 hits/probes, while
solver counters grow ~2-4x. Children reconcile to phase walls exactly;
guest walls reconcile to host guest-call within ~3ms
(`guestUnattributedMs` p50 2.4/3.7ms).

## Overhead and identity (same closure as above)

- Prefix, 9 interleaved off/phase pairs: medians 719.2 -> 737.6ms,
  **+2.56%**, under the 5% gate. Full, 1 pair: 8184.9 -> 8051.3ms
  (-1.63%, noise). No reduction needed; no second tier added.
- Traced vs untraced `work` bit-identical on both inputs (all 12
  counters); type/effects/target-preflight identical.

## Commands

```bash
# Rebuild after touching compiler/src (release, pinned toolchain)
deno run --allow-read --allow-write --allow-run=cargo,git,rustc --allow-env scripts/build_compiler.ts

# One telemetry sample (JSON on stdout; guest schema 2 under .phaseTelemetry.rust)
deno run --allow-read --allow-env --allow-sys experiments/compiler-bench/cold-semantic/sample.ts \
  --fixture=$PWD/experiments/compiler-bench/cold-semantic/full.blot \
  --mode=fresh-process-first-analysis --telemetry=phase

# Verification batch (from the repo root; raw.jsonl + summary.json with telemetrySummary)
deno run --allow-read --allow-write --allow-env --allow-sys --allow-run=deno,git \
  experiments/compiler-bench/cold-semantic/run.ts \
  --fixtures=$PWD/experiments/compiler-bench/cold-semantic/prefix.blot,$PWD/experiments/compiler-bench/cold-semantic/full.blot \
  --samples=2 --runs=1 --out=experiments/compiler-bench/cold-semantic/telemetry_t1 --telemetry=phase

# Suites: cargo test --manifest-path compiler/Cargo.toml (642 green);
# node --import ./src/node/deno_test_compat.mjs --import tsx --test
# --test-isolation=none src/compiler/session.test.ts src/compiler/wasm.test.ts (31 green);
# performance_gate + refinement/value pathologies green (2+32+56);
# deno check run.ts sample.ts src/compiler/wasm.ts src/compiler/session.ts
```

## Caveats for later packages

- `unionVisits` (and similar order-sensitive counts) vary +-small across
  native processes (observed 13280/13284 for identical input): union member
  traversal short-circuits in hash order. On an earlier closure the Wasm
  build showed a deterministic -4 unionVisits traced-vs-plain artifact;
  T1 adds no semantic calls versus the A-phase traced path (the only
  call-sequence delta is the pre-existing extra cached check), and on the
  current closure traced/untraced work is bit-identical. Compare those
  counters with tolerance, or via medians.
- `uniqueInputs` is a lossy lower bound (closures by module/body, deep
  values by shape, bounded walk); use the exact memo counters for
  memoization arguments.
- The shared checkout drifted during T1 (ambient `@effect.meta` /
  `@effect.attach_meta` primitives + prelude edits + a third-party
  rebuild: artifact 8a91b9f2 -> 30d81f09). All T1 numbers above are on the
  final closure (artifact 30d81f09…, prelude dd980347…); in-batch
  provenance is stable, and the earlier-closure overhead pairs agreed
  (+2.22% prefix, +0.68% full). Keep this instrumentation byte-identical
  between baseline and candidate runs.
- One full-suite run showed a single flaky failure
  (`effect_metadata_survives_row_inference`, plausibly related to the
  ambient effect-metadata work); it passes in isolation and the suite is
  642/642 green on two subsequent full runs including the final tree.
