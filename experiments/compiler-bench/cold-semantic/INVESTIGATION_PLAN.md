# Blot: investigation and fix plan for slow cold semantic analysis

Repository: `mewhhaha/blot` Inspected baseline:
`f5e0957db3f69a09022bb295c383454d05444568` (`main` when inspected) Prepared:
September 15, 2026 Status: **Plan only. No compiler changes, reproducer
implementation, or benchmark runs were performed for this handoff.**

The phases below describe work for the receiving agent. The first implementation
work should establish reproduction and attribution, not change compiler
semantics. Names explicitly marked **proposed** are new files or interfaces to
create, not existing commands.

## Executive recommendation

**Measure target preflight and Runtime-HIR elaboration before optimizing the
solver.** Repository inspection establishes a concrete measurement gap, not a
root cause. `analysis_json` returns before `close_program` executes, so its
already-materialized `work` payload cannot account for later work unless that
payload explicitly incorporates a separate subsequent measurement.
`close_program` also starts another semantic request; request resets must be
audited before interpreting counters. The modest solver-counter increase
therefore does **not** establish that all relevant compiler work grew modestly.
[R2-R4]

The closed-program cache is a plausible contributor to the cold/warm difference,
but neither this nor the call graph establishes where the seconds are spent. The
first decisive experiment is an end-to-end trace with separate checking,
analysis-fact materialization, HIR elaboration, and backend-closure spans.

**Do not fix this by omitting target preflight.** Ordinary analysis exposes this
fact, and the language service consumes it. Preserving an answer requires more
than preserving the principal type. [R8]

## 1. Scope and evidence already supplied

First Deno `analyzeSource` call ~6,000 ms, resident unchanged ~30 ms, after edit
~50 ms. Fast prefix ~500-600 ms; final `Loop.run` adds ~5,400 ms. Worker-thread
change fixes formatting interference, not this cost. [R1]

Triggering implementation: three `ECS.build`, three `ECS.schedule`,
`@type.union_of` over the world. External `gdev` checkout was not inspected and
is not a required dependency.

Counters (fast prefix -> full): typeNodes 2067->2752, typeInterns ~57k->~68k,
constraints 2913->4327, settleVisits ~101k->~118k, freshenVisits ~4.5k->~5.2k,
unionVisits 2500->4340, boundaryMaterializations 158->172, captureCandidates
15->32, capturesBridged 13->29, solverWorklistPeak 45->128,
interfaceFieldsDemanded 1->2.

Small measured costs for Wasm load/instantiate, buffer parsing, graph loading,
file chains, trivial prelude file, individual dependencies: retain as controls.

**Provenance limitation:** original hardware, exact artifact, invocation, raw
samples not supplied. Numbers are leads, not benchmarks or acceptance
thresholds.

### Invariants

Rust/Wasm sole semantic authority. Polynomial biunification; ownership/linearity
outside the type lattice. Specialization before validated Runtime HIR (backend
boundary). No Baba grammar/lexer changes, no new parser. Preserve
demanded-program semantics, generative identities, exact conversion, principal
types, effects, diagnostics, target answers. [R5-R6]

Language/inference changes require `LANGUAGE.md` same-diff;
pass/cache/certificate/benchmark changes require compiler spec same-diff.
Optimization-only patches leave semantics unchanged. [R5-R6, R9]

## 2. Phase 0 - freeze baseline and measurement contract

Record working commit, worktree changes, Wasm/manifest/prelude hashes, compiler
input identity, Rust toolchain, Deno/V8, invocation, OS/arch/CPU/RAM/power,
deps, env flags. Recheck provenance per batch; reject mixed-input batches. Clean
worktree; re-resolve symbols if commit differs.
`pnpm install --frozen-lockfile`; `pnpm compiler:download` or (Rust changed)
`pnpm compiler:build` as alternative artifact paths, never inside a timing
sample. Release profile opt-level=s, fat LTO, one codegen unit, stripped; debug
builds invalid as baseline. [R7, R10]

Reuse `experiments/compiler-bench/` machinery with a new named boundary; follow
`spec/COST_MODEL.md` (stable paths, raw retention, parity, independent runs).
[R9, R11]

Keep four measurements separate: fresh-process first analysis (new Deno child
per sample; `Compiler.create()` timed separately; no priming); operational cold
total (spawn through exit); fresh session in existing process (diagnostic only);
resident unchanged/edited. Source read may be outside call clock if reported. No
`portableGraph`/`prepare`/`checkSource`/priming before canonical cold
measurement. Fresh `Compiler.create()` in a reused process is not fresh-process
proof (immutable Wasm cached, fresh semantic state). [R6]

Three independent batches of >=15 fresh-process samples per input/build. Rotate
order, no CPU contention. Report every duration, batch medians, aggregate
median, MAD, sample-limited p95. No index pairing, no discarding startups. Noise
rules on every batch and control. [R9]

Exit: benchmark manifest, immutable baseline distribution, runnable protocol. No
optimization yet.

## 3. Phase 1 - in-repository reproducer

Proposed layout `experiments/compiler-bench/cold-semantic/`: README.md,
framework.blot, prefix.blot, full.blot, controls/, generate.ts (emits source
only; never parses Blot), sample.ts (one child-process sample), run.ts
(processes, ordering, aggregation, provenance).

Construction: (1) start from case-studies/ecs/ecs.blot, planning.blot,
examples/lib/retained_state_loop.blot idioms [R12-R14]; (2) abstract app builder
with new/add_plugin/add_component/add_systems record pipelines, distinct
scalar/record shapes and closures, no graphics/fetches/effects/external
checkout; (3) forcing sink with local build-like/schedule-like/@type.union_of
operations; full sink does three builds + three schedules; preserve captured
records and nested closures; (4) demanded workload: export finite first-order
function over runtime-provided argument depending on every selected
component/system; one bounded tick + checksum; record demand evidence; minimal
constant public annotation; (5) controlled family: prefix, full, intermediate
stages, identity/build-only/schedule-only/union-only sinks, 1-vs-3 variants,
combinations, same-vs-distinct shapes, shared-vs-duplicated descriptors,
repeated-vs-distinct closures; (6) scale components x systems over 1,2,4,8,16,32
(64 only if needed); then record width and depth separately; minimize preserving
phase signature; freeze bytes+params before evaluating fixes.

Record inference outcome, diagnostics, principal result/effect strings,
targetPreflight per input. A fast prefix that refuses an unsupported boundary is
not outcome-equivalent to a completing full program: add supported
outcome-matched controls before attributing.

Reproducer acceptance (proposed qualification targets): self-contained (no
gdev); repeated cliff (full/prefix median >=5x AND full-minus-prefix >=1000ms,
every batch, outside noise); original-machine matching targets (~4000-8000ms
full, <=800ms prefix) when identifiable; counter signature same order of
magnitude, <=~3x growth on listed nonzero measures; phase signature matches
forcing/elaboration mechanism once traced; valid semantics (stable
types/effects, demand, target answer, finite runtime observation). Original
counters are anchors, not goldens. Smaller fixture with same pathology may serve
as unit regression alongside a qualified end-to-end fixture. If unqualifiable:
report **original issue not yet reproduced** with tested variants; claim no fix.

Harness contract: generate.ts --components/--systems/--stages; sample.ts
--fixture --mode=fresh-process-first-analysis; run.ts launches new Deno process
per cold sample at stable paths; JSON output with provenance, createMs,
analyzeMs, operational total, full work, phase telemetry, memory, semantic
results; failures as classified outcomes, never missing/zero-duration;
logging/validation outside call clock, inside operational total.

## 4. Phase 2 - attribute wall time

Opt-in coarse tracing first; request ID surviving nested preparation; preserve
reset behavior while observing. Boundaries: host source/transport
(analyzeSource, loadWorkspaceRevision, syncLoaded, analyzeResident, wasm.ts
call/decode; split source/transfer/guest/decode/parse); semantic preparation
(begin_semantic_request, ensure_current, boundary publication; modules, imports,
caches, nested resets); checker+facts (check, analysis_json; split
inference/settling vs
coverage/ownership/comptime-eval/type-formatting/fact-materialization); target
preflight (close_program inside analyze_module; split
lookup/re-prep/HIR/backend); staging/specialization (hir.rs, eval.rs,
residual_identity.rs, residual_cache.rs; eval/key/specialization/closure/HIR
separately); validation/layout (Runtime-HIR validation boundary, backend::close,
layout planning; verify no emission); response/cleanup (serialization,
alloc/copy, decode, drops; destroy/exit separately). Nested spans,
inclusive+exclusive, charge once. [R2-R4, R6, R9]

Monotonic clock native; verify clock facility on Wasm target (no assumed
Instant); profiling-only imported host clock if needed with compatibility notes.
Telemetry out of semantic identities/certificates. Capture counters per phase
before resets; keep old result.work unchanged; add separately named
whole-request/phase observations; phase-local maxima for peaks.
development-profile gives memory observations, not timing coverage. [R4, R7, R9]

Also record: distinct graph nodes/edges, repeat visits, depth, union
widths/comparisons, hash/eq bytes, materialized/printed bytes; shared vs
expanded size. Specialization: requested/unique keys, hits/misses, bodies
specialized/restored, residual/HIR counts, env sizes, key time. Eval:
applications, reconstruction/lookups, identity allocations, repeated-vs-distinct
inputs. Memory: guest pages, allocator bytes, host RSS, hotspots. Bounded
heavy-hitter summaries on stable IDs. No giant-type stringification per event,
no clock import per solver visit.

Profiles: matched prefix/full, first/resident, uninstrumented-vs-tracing
controls. Deno --cpu-prof/--cpu-prof-md/--cpu-prof-flamegraph per pinned-version
flags (no runtime upgrade for profiler). Keep raw profile, bottom-up self-time,
call tree, phase trace. Preserve Wasm names/symbols in equivalent optimized
profiling artifact; record flags/size/parity. [E1]

If guest frames opaque: same pipeline via in-crate native test/driver (crate is
cdylib; no existing bench executable), optimized symbols, Linux perf,
raw+demangled stacks. Localization only until confirmed in Deno/Wasm. V8 tiering
caveat: unprofiled first-call timings are the latency authority;
fresh-vs-session and tier controls are diagnostic. 77ms load time does not rule
out first-use engine compilation. [E2]

Attribution gate: explain >=90% of slow-minus-prefix delta with non-overlapping
phase work and/or measured runtime/host overhead; show remainder. Tracing
overhead <5% or reduce/separate. Sample proportions and elapsed spans never
added.

## 5. Ranked hypotheses and decisive experiments

H1 target preflight forces staging/specialization/backend closure: compare
checkSource vs analyzeSource with nested trace isolating
analysis_json/hir::elaborate/backend::close; count unique specializations,
residual bodies, HIR size, preflight cache hits. Positive: delta below
close_program -> inspect dedup/keys/representation/layout per sub-evidence.
Negative: follow dominant checking span. Never ship checkSource as analysis
substitute.

H2 comptime eval rebuilds/traverses worlds+schedules:
1-vs-3/shared-vs-duplicated/union variants; eval call counts, unique inputs,
allocations, conversion time split by invoker. Positive: eval
time+reconstruction explain cliff -> environment retention, call-local reuse,
exact conversion. Negative: keep controls, look at specialization/solver/output.
Equal inputs do not prove safe memoization with fresh variables/generative
identities.

H3 structural work inside modest counts: vary graph depth/field width/union
width independently; bytes/nodes hashed/compared/cloned/converted/printed per
op; profile typecheck/value-bridging/formatting; one large type vs many shared
facts. Positive: time follows expanded traversal/formatting -> optimize measured
traversal. Negative: deprioritize structural. TypeList/TypeRow already shared;
no blind Rc-adding. [R15]

H4 repeated preparation/boundary/cache-identity work: trace both
begin_semantic_request entries; attribute
checks/interfaces/fingerprints/key-construction per request+module; repeated
identical vs distinct environments. Positive: equivalent work repeats within one
revision or keys dominate despite hits -> revision-safe memoization or
redundancy removal after proving identical consumed facts. Negative: keep
invalidation; keep cache-key tests.

H5 memory allocation/copy/drop dominates: correlate alloc volume/guest
growth/RSS/stacks with cliff; include destruction, next edit, fresh-session
repetition. Positive: fix specific reconstruction/clone/growth/retention
pattern. Negative: compute-heavy stacks rule out allocator-first fix. Retaining
everything forever fails memory/lifecycle gates.

H6 engine first-use or host output processing: fresh session after prior
analysis, unrelated priming, tier controls, native profile; split
guest/serialize/decode; record same-work-done. Positive: faster fresh sessions
implicate engine/code-cache; dominant JSON/formatting implicates output.
Negative: focus on Rust phase. Prewarming is diagnostic, not the fix.

## 6. Fix directions, in evidence order

A. Remove redundant immutable traversal/materialization. Needs: repeated
traversal/conversion/formatting of same immutable graph dominates. Blast radius:
type/value bridges, printers, analysis JSON, certificates if touched. Preserve
fresh-variable memoization exclusion or prove replacement. [R16] Docs/tests:
COST_MODEL + TYPECHECKING/STAGING contracts on identity/reuse change;
graph-visit bounds; exact principal-type/effect/fact comparisons. No LANGUAGE.md
expected.

B. Deduplicate specialization or cheaper keys. Needs: repeated equivalent
instances/closures/envs or key cost dominates HIR time. Blast radius: hir.rs,
residual identity/cache, envs, development prep, invalidation. Keys keep
revision/representation/env/effect-seal/generative distinctions; no printed
types/unscoped addresses/plain-hash identity. Docs/tests: COMPILER.md,
STAGING.md, INCREMENTAL.md; schemas only on real representation change;
fresh-variable/generative/recursive/principal/HIR/determinism/invalidation
tests.

C. Reduce build/schedule eval reconstruction. Needs: repeated static
construction/lookup/conversion dominates. Blast radius: evaluator/values,
snapshots/capsules on layout change. Keep field order, union_of, failures,
payloads, nominal/effect identities. No ECS-specific compiler rules. Docs/tests:
STAGING/CORE_SEMANTICS/INCREMENTAL/COST_MODEL;
exact-value/payload/shared-graph/staging/effect/ownership + evaluator/Wasm
parity.

D. Optimize target preflight without weakening answer. Needs: backend
closure/layout dominates after necessary specialization. Blast radius: session
orchestration, backend::close, HIR validation, layout, prepare/compile, editor
diagnostics. Separate cheaper preflight is higher-risk: must consume adequate
authoritative facts and prove agreement, never approximate open types in TS.
Docs/tests: COMPILER/STAGING/RUNTIME/INCREMENTAL + ABI ops docs;
supported/refused boundaries, exact refusals, error classes. Monomorphization +
HIR validation stay mandatory. No removing/delaying/defaulting target facts.

E. Allocation/build-config last. Needs: allocator/copy/engine effects explain
substantial residual. Blast radius:
allocator/Wasm/teardown/size/distribution/provenance/possibly every command. One
controlled change at a time; no mixed semantic+profile patches. Docs/tests:
COST_MODEL + distribution contracts; all semantic observations, auth, warm/edit
controls, lifecycle memory. Bigger binary/moved compilation cost charged to
operational total.

## 7. Phase 3 - semantic equivalence + improvement proof

Semantic acceptance: snapshot baseline reproducer+controls pre-optimization.
Compare principal types, effects, editor facts, diagnostics with real
spans/classes, target preflight, executable observations. Never bless new
goldens because it compiles. Alpha/format changes need explicit explanation +
structural evidence; silent widening fails.

Keep existing regressions: pnpm test:compiler, pnpm conformance, pnpm
test:regression, pnpm test:ecs, pnpm test:lsp, plus node --import
./src/node/deno_test_compat.mjs --import tsx --test
src/compiler/performance_gate.test.ts
src/compiler/refinement_pathologies.test.ts
src/compiler/value_pathologies.test.ts (adjust only if harness changed at
selected commit). Performance gate: no semantic recheck on unchanged/source-only
revisions, bounded invalidation on private leaf edit. Value pathologies: exact
types, evaluator results, emitted Wasm, cold/warm bytes, classified negatives.
[R7, R16-R18]

Add focused tests: repeated generics with independent variables, distinct
generative effects/seals, recursive/shared types, invalid union members, record
ordering, ownership failures, cache-on/off agreement, edited-vs-fresh agreement,
stable output across restarts (critical for caches/DAG changes).

Executable fixtures: prepare + validate Runtime HIR, validate emitted Wasm,
compare evaluator vs emitted-runtime observations at conformance boundary. Check
no unresolved variables, unspecialized comptime values, missing ownership facts,
invalid representation refs. Deterministic bytes when expected; intentional
lowering changes need semantic/ABI parity, never assumed harmless/wrong.

Performance acceptance (proposed targets to ratify with first valid baseline):
full-minus-prefix median delta down >=75% with full median materially lower
(slowing the prefix disqualifies); on ~6000ms-full/~600ms-prefix hardware use
2000ms full initial target, 1000ms stretch. Controls (resident unchanged,
semantic edits, trivial/prelude, chains, single-module) regress at most 10% +
noise gate; freeze decision rule pre-candidate. Deterministic no-work assertions
where applicable. RSS/guest/teardown/edits: flag >10% for review; retained
structures need bounded lifetime+size argument. CI gets work/scaling assertions;
absolute ms gates only on controlled runner. Scaling tests are regression
evidence, not polynomial proofs; explain new memoization/traversal bounds.
Hotspot profile + phase time must improve as predicted; faster total with
unchanged hotspot is insufficient. Final claims on uninstrumented
production-equivalent artifact only.

## 8. Non-goals and risks

No LSP lane/worker redo, debounce changes, deferred analysis, prewarming-as-fix.
No semantic work in TS, no checkSource-for-analysis. No removing target
diagnostics/facts/HIR validation/ownership/exact-conversion/specialization. No
Baba/grammar/parsing changes, no Loop/ECS/path special-casing, no rewriting the
user app as the fix, no forced annotations erasing inference. No union widening,
type collapsing, budget-lowering to skip work, budget-raising to hide
super-polynomial behavior, no synthetic-offset diagnostics. No persistent
semantic caches first (symptom is first-process work; warm is fast); any cache
must win on canonical cold request and respect
revisions/variables/identities/memory. Call-local identity is not portable
identity.

Risks: false reproducer via demand loss, prefix/full outcome mismatch,
pre-sampling counter resets, expanded-tree traversal, tracing-induced cost, V8
tier changes, cross-instance contamination, moved teardown, bad provenance; each
has a named control above.

## 9. Work packages and required agent report

Package A (reproduction + observability): qualified fixture family, proposed
harness, provenance, raw baseline results, opt-in phase telemetry. No
algorithmic change. Identical observation instrumentation across
baseline/candidate.

Package B (one evidenced fix): narrowest attribution-supported change.
Cache/complexity argument, focused semantic tests, same-diff spec updates. No
unrelated cleanup or bundled theories.

Package C (regression protection + final report): deterministic work/scaling
regressions, controlled benchmark comparison, conformance/editor verification.
Remove temp experiments or isolate retained opt-in profiling interface.

Final report must include: baseline/candidate commits, worktree identities,
artifact hashes; machine/toolchain/runtime/flags/benchmark boundaries; exact
self-contained reproduction command + frozen fixture params; original-issue
reproduction status + missing external evidence; raw sample/provenance files +
per-batch/aggregate stats;
prefix/full/unchanged/source-only/semantic-edit/control results; original + new
phase-local measurements; where cold delta was spent + unresolved remainder;
winning hypothesis + distinguishing experiment; fix/mechanism/blast
radius/complexity-cache argument; principal
types/effects/diagnostics/target/HIR/runtime parity;
memory/size/teardown/scaling; same-diff spec updates; remaining risks,
unsupported claims, rollback condition.

Stop speculative optimization when reproduction or attribution gates fail.
Report the evidence gap; claim no fix. Completion = reproducible full first-call
analysis-cost reduction with existing answers preserved.

## Source ledger (inspected at f5e0957d unless noted; recheck at execution baseline)

R1 worker-thread isolation commit; R2 src/compiler/session.ts
analyzeSource/entries/distribution cache; R3 compiler/src/host_transport.rs
analyze_module + unused _requested_fact_mask; R4 compiler/src/session.rs
analyze_module ~line 650, close_program, begin_semantic_request, ensure_current;
R5 AGENTS.md authority/rules; R6 spec/COMPILER.md pass graph/caches/fresh
sessions/boundaries; R7 package.json commands; R8 docs/abi.md +
src/language_service.ts target preflight in editor analysis; R9
spec/COST_MODEL.md classes/provenance/noise/phases; R10 compiler/Cargo.toml
release (opt-level=s, fat LTO, 1 codegen unit, stripped), cdylib,
development-profile; R11 experiments/compiler-bench/benchmark.ts
provenance/observations; R12 case-studies/ecs/ecs.blot; R13
case-studies/ecs/planning.blot; R14 examples/lib/retained_state_loop.blot; R15
typecheck.rs shared TypeList/TypeRow; R16 examples/pathologies/VALUE_GRAPHS.md
conversion/payloads/bounds/variable-memoization; R17
src/compiler/performance_gate.test.ts; R18 pathologies README + principal-type
tests; R19 spec/README.md contract ownership. E1 Deno CPU profiling docs; E2 V8
Wasm compilation pipeline docs.
