# Cold-semantic Package A3 evidence (formal baseline + attribution)

Artifact under measurement: `generated/compiler/compiler.wasm`
`9f73b799bbc6...` (manifest `compiler-artifact.json` in the frozen copy;
prelude.snapshot `ecb5fc95...`), HEAD `f5e0957d`, release profile,
rustc 1.97.1, Deno 2.9.6. A2 phase telemetry present and verified
(host spans + 4 guest counter phases, saturating deltas).

## Why a frozen copy

The shared checkout was rebuilt by another agent every ~5-15 min during
measurement (`baseline/batch1`, `batch2` both correctly rejected on
closure drift; artifacts `1b12`/`86bc`/`c377`/`6aa3` superseded).
`baseline/clean0..2` and all of `attribution/` were measured in a
byte-frozen rsync copy (`/tmp/blot-cold-a3`, `compiler/target/` excluded)
taken at a self-consistent triple (manifest matches wasm+prelude bytes).
Absolute paths in those files point at the copy; fixture/harness bytes
are identical to this repo (prefix `009d4e05`, full `8ec9d28a`,
framework `18b58293`, generate `47eb5c42`). Raw evidence was copied back
here unchanged. See the Package A3 report for the full analysis.

## Batches (all provenance-stable unless noted)

| Dir | Content |
| --- | ------- |
| `baseline/batch0` | 15x8 ACCEPTED but SUPERSEDED (artifact `1b12bdd1`, since overwritten) |
| `baseline/batch1` | 15x8 REJECTED (mixed artifacts mid-batch, retained as evidence) |
| `baseline/batch2` | 15x8 REJECTED (mixed artifacts mid-batch, retained as evidence) |
| `baseline/clean0..2` | FORMAL BASELINE: 3x(15 samples x 8 fixtures), 360/360 ok, artifact `9f73` |
| `attribution/telemetry_pf` | `run.ts --telemetry=phase`, prefix+full, 5 samples each |
| `attribution/splits` | API-split matrix (check/analyze/prepare/compile + sequences), 80 samples |
| `attribution/splits_h6` | H6 priming (second_compiler, prime_trivial), 20 samples |
| `attribution/scales` | Systems scaling series (5 fixtures x 5 samples) |
| `scales/` | Scaling fixtures (see table below; `--framework=../framework.blot`) |

API-split probe source (scratch, not part of the repo): `/tmp/coldattr/probe_final.ts`
(run `.sh` driver: `/tmp/coldattr/run_splits.sh`).

## Scaling fixtures (generated, never hand-edited)

| File | sha256 (12) | Params |
| ---- | ----------- | ------ |
| `scales/full_c4s1.blot` | `efb12a9f81bd` | C=4 S=1 K=1 sink=full |
| `scales/full_c4s2.blot` | `400102e09271` | C=4 S=2 K=2 sink=full |
| `scales/full_c4s4.blot` | `3a25e8d4f5e9` | C=4 S=4 K=2 sink=full |
| `scales/sched_c4s2.blot` | `821401124bab` | C=4 S=2 K=2 sink=schedule-only |
| `scales/sched_c4s4.blot` | `d4d2012a8e8f` | C=4 S=4 K=2 sink=schedule-only |

Headline (aggregate medians, n=45/fixture): prefix 652.4ms, full
7196.2ms, ratio 11.0x, delta 6543.8ms; every batch passes the >=5x and
>=1000ms gates. Work/type/effects/preflight bit-identical per fixture
across all 360 samples.
