# Package B fix candidate — request-scoped comptime memo (NOTE)

## Change (one mechanism)

`compiler/src/eval.rs`: the comptime call-result table moved from per-`Runtime`
(per checker evaluation) to per-`Context`, shared by every evaluation in one
semantic request and cleared in `Checker::begin_request`
(`compiler/src/typecheck.rs`, one line). Memo keys keep the same admission
rules (pure monomorphic signature, first-order bounded argument/result, no
residual) and gain the evaluation phase (evaluation is phase-sensitive:
integer-range checks and comptime-only primitives reject at runtime phase).
Identity keys stay weak but a hit additionally requires every keyed scope to
still be allocated, so freed scopes can never satisfy a call even if their
addresses are reused; dead entries are removed on encounter to reclaim the
65,536-entry budget. Net effect: identical pure subcalls shared across the
schedule×world evaluations instead of recomputed per binding.

Superseded variant: strong-identity keys (artifact `9f217e67`, batch `b0`).
Same gross win, but pinning every temporary call scope until request end cost
+281ms re-prepare drop time and +391MB RSS on full. The weak+upgrade design
keeps the win without the retention. `b0` is retained as evidence only.

## Batches

- Baseline: `t2_baseline/b{0,1,2}` (artifact `30d81f09`, Deno 2.9.6), 3×15×8.
- `b0`: strong-key variant (artifact `9f217e67`), 1×15×8. SUPERSEDED
  (provenance recorded from the experiment dir, so artifact fields are null
  in-band; closed out-of-band: wasm `9f217e67…`, manifest `ee418be4…`).
- `b1`: weak-key + phase-key candidate (artifact `e483d6b8`), 1×15×8,
  launched from the repo root so artifact provenance is in-band. OFFICIAL.

## b1 numbers (official, n=15/fixture, 120/120 ok, provenance stable)

analyzeMs p50 vs T2-b1 (MADs in parens):

| fixture        | T2-b1       | b1          | delta        |
|----------------|-------------|-------------|--------------|
| full           | 8199.2 (68) | 7035.8 (63) | −1163.4 (−14.2%) |
| prefix         | 750.9 (7)   | 725.6 (11)  | −25.3 (−3.4%)    |
| full−prefix Δ  | 7448.3      | 6310.2      | −1138.1 (−15.3%) |
| full_c8s8      | 8598.1      | 7387.9      | −14.1%       |
| full_stages1   | 6566.4      | 5693.2      | −13.3%       |
| schedule_only  | 4778.0      | 4219.6      | −11.7%       |
| full_c2s2      | 1201.6      | 1136.7      | −5.4%        |
| union_only     | 1610.3      | 1546.4      | −4.0%        |
| build_only     | 1564.7      | 1527.3      | −2.4%        |

Every fixture improves; schedule-heavy ones improve most, matching the
mechanism (shared pure subcalls across plan evaluations). Full separation
is ~18× MAD. Prefix is faster (−3.4%), not slowed.

Phase detail (full p50): prep.eval 6320.7 → 5194.9 (−1126ms, −17.8%);
prep.other 1347.8 → 1307.1 (−41ms); re-prepare 20.5 → 32.9 (+12ms weak-key
drop cost, vs +281ms under strong keys); hir-elaborate 252.5 → 243.2;
facts flat. Eval steps 4,858,513 → 4,014,502 (−17.37% exact); closure
applications 401,077 → 332,118; request-wide memo uniques 45,053 (69% of
the 65,536 budget). The +54 steps vs the strong-key run are lost
cross-phase hits: the phase key correctly splits the few runtime-phase
checker evaluations from comptime ones.

Parity (120/120): principal type, effects, evaluator observation, target
preflight, and diagnostics bit-identical on all 8 fixtures. Solver work
counters identical except `unionVisits` (+360 on full, +0.9%,
deterministic across all 15 fresh processes): skipped evaluations renumber
subsequent fresh identities, perturbing solver order with identical
results. RSS: full +13.7MB (+4.0%), all others within ±8.5% — under the
10% flag (vs +391MB under strong keys).

§7 gap (disclosed): the full−prefix delta is down 15.3%, not the proposed
75%. Per-body step attribution (temporary native probe, since removed)
shows the residual is inherent single-evaluation interpretation
(fold/array/comparison/boolean machinery over the user program's
superlinear schedule analysis) plus duplicate subcalls that are unsound to
share without closure canonicalization (fresh identities per creation),
borrow-purity analysis (fold/array machinery carries borrows), or
user-algorithm changes. No narrow sound change reaches further; see the
Package B report.

## b0 numbers (superseded strong-key variant, for the record)

analyzeMs p50 (n=15, MAD in parens) vs T2-b1:

| fixture        | T2-b1       | b0             | delta        |
|----------------|-------------|----------------|--------------|
| full           | 8199.2 (68) | 7442.7 (98.8)  | −756.5 (−9.2%) |
| prefix         | 750.9 (7)   | 723.7 (8.6)    | −27.2 (−3.6%)  |

- full eval steps 4,858,513 → 4,014,448 (−17.4%, exact).
- full prep.eval wall 6320.7 → 5267.7 (−1053ms); re-prepare 20.5 → 301.8
  (+281ms drop cascade); facts/HIR flat.
- Answers bit-identical (type/effects/observation/preflight/diagnostics);
  solver `unionVisits` shifts deterministically (+360 on full, +0.9%) with
  identical inferred types (fresh-identity renumbering from skipped
  evaluations perturbs solver order only).
- RSS full 342.0 → 733.5MB (+391MB): strong-key retention. Unacceptable;
  motivated the weak-key redesign.

## Residual risks (carried by the shipped design too)

- Expected types are not part of the key (same as the previous per-entry
  table); cross-entry sharing widens that pre-existing assumption. Validated
  by 647 lib tests + full §7 battery + 120-sample bit-identical answers.
- Skipped evaluations renumber subsequent fresh identities; solver order
  shifts deterministically (unionVisits +0.9%) with identical results.
- 65k entry budget: full needs ~45k distinct keys (temp single-use entries
  included); larger workloads saturate gracefully (recompute, never wrong).
