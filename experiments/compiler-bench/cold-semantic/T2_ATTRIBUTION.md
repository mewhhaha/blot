# Package T2: formal baseline + attribution with guest timing

Follow-up to T1 (guest wall timing + schema 2). No algorithmic or semantic
changes in this step: measurement and decisive experiments only.

## Identity and provenance

- HEAD `f5e0957db3f69a09022bb295c383454d05444568` (matches expected; nothing
  checked out, committed, branched, or pushed).
- Artifact under measurement, constant for every sample in every batch:
  `generated/compiler/compiler.wasm` `30d81f0974849ede…` (T1-instrumented
  release build, built 13:07 from the dirty tree),
  manifest `d712f4836be63f14…`, prelude.snapshot `dd980347acb0c39a…`.
- Host: Deno 2.9.6 (V8 15.0.245.2-rusty), Node v24.12.0, pnpm 11.21.0,
  rustc 1.97.1, Linux x86_64 (Ryzen 7 7800X3D, 16 threads).
- Frozen inputs unchanged: prefix `009d4e05`, full `8ec9d28a`,
  framework `18b58293`, generate `47eb5c42`, sample.ts `30d7da57`;
  run.ts `36c85c24` (T1 telemetrySummary), t2_probe.ts `26660694a20a`.
- Canonical boundary: fresh-process first `analyzeSource` (new Deno child
  per sample; `createMs` timed separately; no priming). All batches run
  `--telemetry=phase` (guest schema 2 + host spans) except the paired
  off-control; overhead re-verified under the 5% gate (below), so the
  phase batches serve as both baseline and attribution.

## Batches (all provenance-stable, order-rotated)

| Dir | Content | Result |
| --- | ------- | ------ |
| `t2_baseline/b0` | 15 x 8 fixtures, phase, prefix-first | 120/120 ok, stable* |
| `t2_baseline/b1` | 15 x 8 fixtures, phase, reversed | 120/120 ok, stable |
| `t2_baseline/b2` | 15 x 8 fixtures, phase, rotated | 120/120 ok, stable |
| `t2_overhead/off` | 5 x {prefix,full}, off | 10/10 ok, stable |
| `t2_overhead/phase` | 5 x {prefix,full}, phase (same window) | 10/10 ok, stable |
| `t2_scales` | 5 x 5 scale fixtures, phase | 25/25 ok, stable |
| `t2_probes/` | 8 ops x {prefix,full} x 5 reps (`t2_probe.ts` + `t2_probe_matrix.sh`) | 80/80 ok, stable |

\* b0 was launched from the cold-semantic directory instead of the repo
root, so run.ts recorded null for the CWD-relative artifact fields.
Out-of-band verification closes the gap: wasm/manifest/prelude bytes and
the 13:07 wasm mtime are identical before/after b0, the in-band scoped
closure is stable, and the git diff stat is unchanged. b1/b2/probes ran
from the root with full in-band capture (artifact `30d81f09` both ends).

`analyzeMs` p50 per batch (MAD in raw summaries):

| Fixture | b0 | b1 | b2 | aggregate n=45 |
| --- | --- | --- | --- | --- |
| prefix | 743 | 751 | 737 | 745.8 |
| full | 8204 | 8199 | 8122 | 8184.0 |
| build_only | 1579 | 1565 | 1543 | 1564.8 |
| schedule_only | 4801 | 4778 | 4721 | 4778.0 |
| union_only | 1583 | 1610 | 1541 | 1578.6 |
| full_stages1 | 6569 | 6566 | 6497 | 6547.5 |
| full_c8s8 | 8564 | 8598 | 8549 | 8566.6 |
| full_c2s2 | 1226 | 1202 | 1189 | 1205.3 |

Reproduction gates per batch: b0 11.0x/+7461ms, b1 10.9x/+7448ms,
b2 11.0x/+7385ms — every batch clears >=5x AND >=1000ms with
separation >> MADs (max MAD 124ms). Aggregate: 10.97x, +7438.2ms.
REPRODUCED: yes. (Absolute bands are leads only per the plan: prefix
746 sits in the ~600 band; full 8184 marginally above the 4000-8000
lead on this evolved tree. Cross-artifact absolutes are not comparable:
A3 measured 7196 on `9f73`; T1 overhead explains only +0.9%, the rest
is tree evolution in compiler sources + prelude between the builds.)

## Attribution (n=45 medians, full-minus-prefix analyze delta 7438.2ms)

| Rank | Span | Prefix | Full | Delta | % of delta |
| --- | --- | --- | --- | --- | --- |
| 1 | semantic-preparation.eval | 96.4 | 6298.4 | +6202.0 | 83.4% |
| 2 | semantic-preparation.other | 415.2 | 1347.8 | +932.6 | 12.5% |
| 3 | target-preflight.hir-elaborate | 26.3 | 249.0 | +222.7 | 3.0% |
| 4 | fact-materialization | 29.2 | 67.1 | +37.9 | 0.5% |
| — | conversion / re-prepare / coverage / ownership / safety / check / backend-close | — | — | +21.9 | 0.3% |
| — | host load/sync/decode delta (127->148 / 5.0->5.2 / 1.4->2.2ms) | — | — | +22 | 0.3% |

Ranked mechanism explains 7395.2/7438.2 = **99.4%**; remainder ~43ms is
the named small spans + host delta + median non-additivity. Gate (>=90%)
MET. Guest walls reconcile to host guest-call within ~4ms
(`guestUnattributedMs` p50 2.5 prefix / 3.8 full).

What the spans are (inspected in `compiler/src/session.rs`):
`semantic-preparation` = `begin_semantic_request` = `ensure_current`
over the module graph (`checker.check` + `publish_boundary` per dirty
module). The named sub-spans carve out checker eval/conversion/coverage/
ownership/safety; `other` = biunification inference + boundary sealing
(`sealed_boundary_bytes`, boundary encoding) + bookkeeping. The `check`
phase (0.1-0.3ms) is a root cache hit on the cold path — all inference
lives in preparation. `target-preflight` = `close_program_inner`
(re-prepare / check / hir-elaborate / backend-close).

## Mechanism (H2 wins)

Comptime evaluation during preparation fans out over schedule x world
combinations: eval steps 74,006 -> 4,858,513 (65.7x), closure
applications 5,282 -> 401,077 (75.9x), while top-level eval calls grow
only ~2.5x (expressionCalls 2973->7456, runs 4658->11265). Cost per step
is constant: 1.30us prefix, 1.30us full, 1.29us schedule_only,
1.22-1.25us across the s1/s2/s4 scale series — full executes 66x more
identical-cost steps, not costlier steps. Comptime memo: probes
2,704->185,494 (68.6x) at 25%->41% hit rate; the 109k miss volume (plus
50,460 nonmemoizable results, 69x) dominates. Reconstructions flat
(3 admitted / 3 decoded-ok on every fixture): not a reconstruction
pathology. Hot-8 expressions (framework.blot 573/596/627 + prelude
9412/9420/9421/9424/9429) fire in lockstep, 33 calls each on prefix,
93 on full — repeated same-shape traversals with distinct inputs
(uniqueInputs lower bound 2708->5052; FNV-lossy, never proof of
equality). Conversion is flat and entirely outside eval
(5.1->12.8ms, insideEval 0): the driver is pure evaluator fan-out.

Decisive double dissociation (sink splits, b0 medians):

| Fixture | analyze | prep.eval | prep.other | settleVisits |
| --- | --- | --- | --- | --- |
| prefix | 743 | 96 | 414 | 131k |
| build_only | 1579 | 244 | 1006 | 310k |
| schedule_only | 4801 | 3770 | 598 | 162k |
| union_only | 1583 | 248 | 999 | 311k |
| full | 8204 | 6315 | 1355 | 346k |

Schedules drive eval (schedule_only: 79% of its time in eval, solver
counters near prefix); builds/components drive other (build_only:
high solver counts, low eval; union_only ~= build_only, union adds
~nothing). Doubling components (full_c8s8) adds ZERO eval (6307 vs
6315) and +308 other. Removing barrier cuts (stages1) removes 1606
eval (-25%) and 44 other. Scale series (full sink): eval 155->416->
1140->6315 per systems doubling (2.7x, 2.7x, 5.5x — accelerating past
linear); other 617->714->883->1355 (mild).

## Hypothesis verdicts

- H1 target preflight forces staging: NEGATIVE as dominant, small
  positive residual (hir-elaborate 3.0% of delta). Probes (n=5, same
  artifact): full check 7850 ~= analyze 8182 ~= prepare 8079 (within
  4%); post-prepare compile 27ms; post-check analyze 396ms = preflight
  248 + facts 69 + re-prep 21 (guest phases confirm). Resident second
  analyze 129ms = facts 75 + prep 0.4 + preflight 0.3 (closed-program
  cache works). Pattern matches A3 on `9f73` (within-artifact ratios,
  not absolutes). Never ship checkSource as analysis.
- H2 comptime eval rebuilds/traverses worlds+schedules: POSITIVE,
  dominant (83.4%). Evidence above: 66x steps at constant us/step,
  76x closure apps, schedule-driven sink split, superlinear scale
  curve, 109k memo-miss volume at 41% hit rate.
- H3 structural work inside modest counts: NEGATIVE as dominant,
  positive 12.5% secondary residual (prep.other, build-driven,
  tracks solver counters 2.6-3.4x). Named spans flat: conversion
  +7.7, coverage +1.2, ownership +1.1, safety +0.8ms. sameType
  16.9k->72.6k (4.3x) lives inside other (not separately timed).
- H4 repeated preparation/boundary/cache-identity work: NEGATIVE.
  Second `begin_semantic_request` (preflight re-prepare) costs
  8.8->19.7ms (+10.8) vs first prep 541->7681ms; published
  boundaries are reused, dirty set empty.
- H5 memory allocation/copy/drop dominates: NEGATIVE as dominant.
  Host RSS 258->342MB (1.33x) vs time 11.0x; fresh-process delta
  +83MB for +7438ms; per-step cost constant (no allocator
  degradation inside eval); c8s8 RSS (326MB) < full (342MB)
  despite bigger input. Guest allocator bytes unavailable (host
  RSS only) — disclosed.
- H6 engine first-use or host output: NEGATIVE. Fresh compiler in
  warm process: full 8063 vs first-call 8192 (1.6%, noise);
  unrelated trivial prime: fixture 8045 vs fresh 8182 (no-op).
  Prefix shows a ~150ms warm-process benefit (746->598, 20%) —
  engine/allocator warmth worth ~2% of the delta, decisively not
  the cliff. Host output: decode +0.8ms (response 347->707KB).

## Fix direction

C — Reduce build/schedule eval reconstruction (evaluator/values blast
radius): repeated static construction + lookup over schedule x world
combinations dominates (4.86M steps, 185k memo probes at 59% miss).
A is weak (conversion flat and outside eval; miss keys are distinct,
not same-graph retraversal); B/D/E have no cost center (preflight
3.3%, emit 27ms, memory 1.3x). Any memoization change must preserve
the fresh-variable/generative exclusion (50k nonmemoizable results)
or prove its replacement; equal FNV inputs never prove safe reuse.

## Equivalence, overhead, determinism

- All 360 baseline samples: type `{ .run = Int -> Int }`, empty
  effects, supported target preflight, one variant per fixture.
  `work` bit-identical per fixture across all 45 samples; eval
  counters (steps/cloApps/runs/memoP/memoH) likewise bit-identical.
- Tracing overhead (same window, same artifact, n=5): prefix
  739.5->751.5 (+1.6%), full 8106.8->8176.3 (+0.9%) — under the 5%
  gate. Traced vs untraced `work` bit-identical on both inputs.
- `createMs` ~78ms flat across fixtures (outside the call clock).
- Noise: per-batch MADs 7-124ms; cliff separation (delta ~7.4s,
  ratio ~11x) clears every batch/control noise gate. b0/b1 tails
  show one elevated final round each (~15%, all fixtures equally,
  transient machine contention); medians unaffected; nothing
  discarded.

## Omitted, unverified, ambient drift

- Shared-vs-duplicated descriptors, repeated-vs-distinct closures,
  record width/depth splits: not generated (generate.ts sinks do not
  cover them); gate met without them.
- Hot-expression source lines (framework 573/596/627, prelude 94xx):
  arena IDs not resolved to source; lockstep counts + modules only.
- `prep.other` sub-split (inference vs boundary sealing) and
  `sameType` time: no finer spans; ranked by counter tracking.
- Guest allocator bytes / pages: unavailable; host RSS only.
- Resident unchanged/edited and semantic-edit boundaries: deferred
  per plan (resident second-analyze 56/129ms observed via probes).
- Absolute ms valid only on this artifact/tree/machine; no pnpm
  install was needed (frozen lockfile untouched, no new deps).
- Ambient drift (other agents, all outside the measured closure):
  `src/tooling/lint/*` edited 17:51-17:52 mid-matrix — exonerated
  (no import edge from the compiler graph: the one "tooling" mention
  in `src/compiler/frontend.ts` is a comment; no rep-correlated step
  in probe data); `compiler/src/hir.rs` + `favicon.svg` changed after
  the last batch (17:57-17:59); wasm bytes + mtime constant all
  session. Every batch is in-band provenance-stable.

## Reproduction commands (from repo root)

```bash
D=experiments/compiler-bench/cold-semantic
deno run --allow-read --allow-write --allow-env --allow-sys --allow-run=deno,git \
  $D/run.ts --fixtures=$PWD/$D/prefix.blot,$PWD/$D/full.blot --samples=15 \
  --runs=1 --telemetry=phase --out=$PWD/$D/t2_baseline/b0
bash $D/t2_probe_matrix.sh   # 8 ops x {prefix,full} x 5, see t2_probes/
```
