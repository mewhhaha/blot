# Cold semantic analysis reproducer (Package A1)

Self-contained reproduction of the slow-first-`analyzeSource` report against
`f5e0957d`, plus the measurement harness for the full baseline batches. No
external checkouts; everything lives in this directory except the shared
`experiments/compiler-bench` schema/observation helpers it reuses.

- Plan: `INVESTIGATION_PLAN.md` (Phase 0 + Phase 1 + invariants)
- Provenance: `provenance.json` (Phase 0 freeze record)
- Manifest: `manifest.json` (frozen bytes/params, pilot evidence, batch plan)

## Layout

| Path                       | Role                                                                         |
| -------------------------- | ---------------------------------------------------------------------------- |
| `framework.blot`           | Abstract app builder: `App`, `Build`, `Systems`, `Plan`, `Schedule`, `Force` |
| `generate.ts`              | Fixture generator (emits source only; Deno or Node+tsx)                      |
| `prefix.blot`              | Frozen fast input: identity sink, C=4 S=8 stages=2                           |
| `full.blot`                | Frozen slow input: full sink (3 builds + 3 schedules + union + runs)         |
| `controls/`                | Sink/stage/scale controls (same family, frozen bytes)                        |
| `sample.ts`                | One fresh-process sample → one JSON doc on stdout                            |
| `run.ts`                   | Batch runner: fresh Deno child per sample, rotation, raw+summary             |
| `pilot/`, `pilot_confirm/` | Small pilot batches (raw evidence, not the baseline)                         |

## Boundaries

- `fresh-process-first-analysis` (canonical): new Deno child per sample, one
  `Compiler.create()` (`createMs`) + one `analyzeSource(path, source)`
  (`analyzeMs`). Source read (`readMs`) sits outside the call clock, inside the
  operational total. No priming of any kind before the canonical call.
- `operational-cold-total`: spawn-through-exit wall per sample (`wallMs`), plus
  the in-child operational total. Result transport and teardown stay in.
- Deferred to later work: fresh session in an existing process (diagnostic),
  resident unchanged/edited, and prepare/compile splits (`sample.ts` takes a
  `--mode` flag so new modes slot in without changing this one).

## Commands

```bash
# Regenerate any fixture (example: the frozen full input)
node --import tsx generate.ts --components=4 --systems=8 --stages=2 \
  --sink=full --out=full.blot

# One cold sample (exit 0 + JSON; classified failures exit nonzero with JSON)
deno run --allow-read --allow-env --allow-sys sample.ts \
  --fixture=$PWD/full.blot --mode=fresh-process-first-analysis

# Small pilot (samples are PER FIXTURE PER RUN; order rotates per run)
deno run --allow-read --allow-write --allow-env --allow-sys --allow-run=deno,git \
  run.ts --fixtures=$PWD/prefix.blot,$PWD/full.blot --samples=3 --runs=1 --out=pilot

# Full baseline (later agent, quiet clean machine, 3 x 15 per fixture)
deno run --allow-read --allow-write --allow-env --allow-sys --allow-run=deno,git \
  run.ts --fixtures=$PWD/prefix.blot,$PWD/full.blot --samples=15 --runs=3 --out=baseline
```

`run.ts` writes `raw.jsonl` (every sample, ok + classified failures) and
`summary.json` (per-run + aggregate median/MAD/p95 over `analyzeMs`, `createMs`,
`wallMs`). It captures the measured input closure before the first and after the
last sample; closure drift rejects the batch. Raw git `status` is recorded but
does not gate (shared-checkout adaptation; ambient drift in
docs/examples/unbuilt sources cannot affect measurement).

## Frozen result (pilot scale, indicative)

Quiet-machine confirmation batch (`pilot_confirm/`, new-artifact `e07d8731`,
load ~4-6, 2+2 fresh-process samples):

- prefix `analyzeMs`: 739.5, 636.8 → median ~688
- full `analyzeMs`: 7072.8, 7158.8 → median ~7116
- ratio ~10.3x, delta ~+6428ms; every full sample exceeds every prefix sample in
  both pilot batches. `createMs` ~80 in all samples.
- Work counters are bit-identical per fixture across samples and engines:
  full-over-prefix growth 2.5-3.0x on every nonzero measure except the two flat
  peaks (see `manifest.json`); time grows ~10x. Same shape as the original
  report (modest counter growth, large time cliff).
- Both inputs check to `{ .run = Int -> Int }` with empty effects and a
  supported target preflight; `run(3)` observes 46 (prefix) / 108 (full).

Iteration leads for Phase 2 (single in-process samples, old artifact):

- The cliff lives on the systems axis: C4/S8 ≈ C8/S8 (~10x), C8/S4 ~4x, C4/S3
  ~2.5x. Components add width, systems add the cliff.
- `prepare()` reproduces the cliff almost exactly (full 6937ms vs prefix 575ms;
  `compile()` is ~25ms both): the cost is at/below HIR preparation, not checking
  or Wasm emission. `analyze()` ≈ `prepare()`.
- Sink split: schedule-only 4018ms, build-only ~1019ms, union-only ~970ms (union
  adds ~nothing measurable at this scale), barriers on (stages=2) vs off
  (stages=1): 6957ms vs 5143ms.

## Fixture-authoring rules (load bearing)

1. **Bind-then-apply.** Never apply a polymorphic framework function directly
   through an import-record projection (`Framework.Systems RowA` mis-checks).
   Bind first: `const SystemsFn = Framework.Systems` then `SystemsFn RowA`.
   Projection+application from a locally built record is fine.
2. **One projection per type argument.** A single projection binding does not
   generalize across distinct row/tag types: `SystemsFn` applied to `RowA` then
   `RowB` fails with `"b" does not flow into "a"`. Project per world
   (`SystemsFn_a`, `SystemsFn_b`, …). Value-argument functions (`App.*`,
   `Plan.group/barrier/then/before`) can share one binding; anything taking a
   row type or tag singleton cannot.
3. **Keep the component namespace.** `Systems` must evaluate its per-field
   component namespace (`cs_components`, effects + attach); the call shape it
   enables was validated against `case-studies/ecs/systems.blot` (identical
   behavior on identical inputs), but do not refactor it without re-running the
   family.
4. `generate.ts` is the only author of fixture bytes; never hand-edit a
   generated file (header records the exact regenerating command).

Findings 1-2 smell like a generalization/identity quirk at import-record
boundaries (possibly generative effect/attach identities); worth a focused probe
in Phase 2, but the fixtures route around it deterministically.

## Readiness and gaps for the next agents

Ready: frozen pair + 6 controls with bytes/hashes/params, working
generate/sample/run harness, provenance + manifest skeletons, pilot cliff
evidence, deterministic counters, demand + preflight proof.

Not done (belongs to later packages): full 15x3 baseline on a quiet clean tree
(rebuild the compiler from it first: the pilot artifact is a dirty-tree build);
resident/edit/session boundaries; opt-in phase tracing (`phaseTelemetry` is
null); same-vs-distinct shape, shared-vs-duplicated descriptor,
repeated-vs-distinct closure, and width/depth control splits; minimization below
C4/S8; per-phase attribution of the cliff.
