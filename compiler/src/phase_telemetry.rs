//! Opt-in guest phase telemetry: wall timing plus sub-phase counters.
//!
//! The host enables collection for one `analyze_module` call by setting the
//! telemetry fact-mask bit; `session.rs` then activates a thread-local
//! [`Collector`] for the whole request. Every hook in this module is a no-op
//! (one thread-local check) while no collector is active, so untraced calls
//! keep their exact behavior and pay only a predictable branch per hook.
//!
//! # Clock
//!
//! On `wasm32-unknown-unknown` the guest has no clock of its own, so timing
//! reads a host-imported monotonic clock: the `blot.now_ms` import, served by
//! `performance.now()` in `src/compiler/wasm.ts`. Native builds (tests and
//! profiling drivers) fall back to a process-epoch `Instant`. The active
//! clock is reported in the payload (`clock`), never assumed.
//!
//! # Accounting
//!
//! Top-level phase spans are sequential wall measurements taken at request
//! boundaries in `session.rs`; they sum to the traced request wall. Nested
//! sub-spans are accumulated per (sub-span, top-level phase) cell and each
//! sub-span charges a phase at most once:
//!
//! - `eval` is the outermost [`crate::eval::run`] wall: nested `run`
//!   invocations count their steps but only the outermost invocation banks
//!   time, so reentrant evaluation is never double-charged.
//! - `conversion` banks value-to-type bridging time. Conversions inside
//!   evaluation overlap the `eval` sub-span; the payload splits them into
//!   `insideEvalMs` (overlaps `eval`) and `outsideEvalMs` (disjoint), and
//!   only the outside part enters the phase residual.
//! - `coverage`, `ownership`, and `safety` are disjoint sequential regions.
//! - `other` is the computed residual (phase wall minus disjoint children,
//!   clamped at zero): inference and biunification live there.
//! - `target-preflight` children (`re-prepare`, `check`, `hir-elaborate`,
//!   `backend-close`) are sequential boundary spans; evaluation inside
//!   preflight is reported under `evalMsByPhase` as informational overlap.
//!
//! # Input fingerprints
//!
//! `uniqueInputs` counts distinct [`fingerprint_input`] hashes over Checker
//! entry calls. The fingerprint walks the lexical environment (bounded depth
//! and width) and mixes binding names with shallow value tags plus scalar
//! payloads. It is deliberately lossy — closures hash by (module, body),
//! deep values by shape — so distinct inputs can share a key and the count
//! is a lower bound on truly distinct inputs. Equal keys never prove equal
//! inputs, and fresh-variable/generative identities are not fingerprinted.
//! Exact memoization evidence comes from the comptime memo counters, which
//! use the evaluator's own keys.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::hash::Hasher;

use crate::value::{Environment, Value};

// Host-imported monotonic clock in milliseconds.
//
// Served by `performance.now()` from the TS host. Declared only on Wasm;
// native builds use a process-epoch `Instant` instead.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "blot")]
unsafe extern "C" {
    fn blot_now_ms() -> f64;
}

/// Monotonic wall clock in milliseconds. See the module docs for provenance.
#[cfg(target_arch = "wasm32")]
pub(crate) fn now_ms() -> f64 {
    // The host always provides this import (extra imports are ignored by
    // modules that do not declare them, so old artifacts stay loadable).
    unsafe { blot_now_ms() }
}

/// Native fallback clock: milliseconds since first use. Tests and profiling
/// drivers only; production timing always comes from the host import.
#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

/// Identifies the clock backing [`now_ms`] in telemetry payloads.
#[cfg(target_arch = "wasm32")]
pub(crate) const CLOCK_NAME: &str = "host-imported blot.now_ms (performance.now)";
#[cfg(not(target_arch = "wasm32"))]
pub(crate) const CLOCK_NAME: &str = "native Instant since first use (test/profile builds only; production uses host-imported blot.now_ms)";

/// Top-level traced phases, in request order.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum PhaseId {
    Preparation,
    Check,
    Facts,
    Preflight,
}

impl PhaseId {
    pub(crate) fn name(self) -> &'static str {
        match self {
            PhaseId::Preparation => "semantic-preparation",
            PhaseId::Check => "check",
            PhaseId::Facts => "fact-materialization",
            PhaseId::Preflight => "target-preflight",
        }
    }

    pub(crate) fn index(self) -> usize {
        match self {
            PhaseId::Preparation => 0,
            PhaseId::Check => 1,
            PhaseId::Facts => 2,
            PhaseId::Preflight => 3,
        }
    }
}

/// Nested guest sub-spans accumulated per top-level phase.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubSpan {
    Eval,
    Conversion,
    Coverage,
    Ownership,
    Safety,
}

impl SubSpan {
    pub(crate) fn name(self) -> &'static str {
        match self {
            SubSpan::Eval => "eval",
            SubSpan::Conversion => "conversion",
            SubSpan::Coverage => "coverage",
            SubSpan::Ownership => "ownership",
            SubSpan::Safety => "safety",
        }
    }

    fn index(self) -> usize {
        match self {
            SubSpan::Eval => 0,
            SubSpan::Conversion => 1,
            SubSpan::Coverage => 2,
            SubSpan::Ownership => 3,
            SubSpan::Safety => 4,
        }
    }
}

/// Per-request telemetry sink. Created by [`activate`], drained by
/// [`snapshot`], discarded when the collection guard drops.
#[derive(Default)]
struct Collector {
    phase: Option<PhaseId>,
    /// Accumulated wall milliseconds per (sub-span, phase).
    sub_ms: [[f64; 4]; 5],
    /// Conversion wall inside evaluation per phase (overlaps `eval`).
    conversion_inside_eval_ms: [f64; 4],
    /// Reentrancy depths; only the outermost level banks time.
    depths: [u32; 5],
    run_depth: u32,
    run_calls: u64,
    eval_steps: u64,
    eval_expression_calls: u64,
    eval_binding_calls: u64,
    eval_cache_hits: u64,
    unique_inputs: HashSet<u64>,
    hot_expressions: HashMap<(String, u32), u64>,
    hot_overflow: u64,
    closure_applications: u64,
    module_applications: u64,
    module_result_hits: u64,
    memo_eligible: u64,
    memo_probes: u64,
    memo_hits: u64,
    memo_stores: u64,
    memo_store_dropped_at_limit: u64,
    memo_nonmemoizable_results: u64,
    memo_unique_max: u64,
    conversion_calls: u64,
    conversion_inside_eval_calls: u64,
    conversion_outside_eval_calls: u64,
    coverage_calls: u64,
    ownership_calls: u64,
    safety_calls: u64,
    template_hits: u64,
    reconstructions_admitted: u64,
    reconstructions_decoded_ok: u64,
    reconstructions_decoded_err: u64,
    reconstructions_fallback_full_eval: u64,
    intern_hits: u64,
    intern_misses: u64,
    same_type_calls: u64,
}

thread_local! {
    static COLLECTOR: RefCell<Option<Collector>> = const { RefCell::new(None) };
}

/// Activates collection for the current thread until the guard drops.
/// Nested activation shares the outer collector; only the outermost guard
/// resets state. Traced analysis never nests; the depth tolerance exists so
/// a reused thread cannot lose or duplicate a request.
pub(crate) fn activate() -> CollectionGuard {
    COLLECTOR.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_some() {
            CollectionGuard { outer: false }
        } else {
            *slot = Some(Collector::default());
            CollectionGuard { outer: true }
        }
    })
}

pub(crate) struct CollectionGuard {
    outer: bool,
}

impl Drop for CollectionGuard {
    fn drop(&mut self) {
        if self.outer {
            COLLECTOR.with(|slot| *slot.borrow_mut() = None);
        }
    }
}

/// True while a collector is active on this thread. Every hook checks this
/// (implicitly, via the `update` helper) before doing any work.
pub(crate) fn is_active() -> bool {
    COLLECTOR.with(|slot| slot.borrow().is_some())
}

fn update(mutate: impl FnOnce(&mut Collector)) {
    COLLECTOR.with(|slot| {
        if let Some(collector) = slot.borrow_mut().as_mut() {
            mutate(collector);
        }
    });
}

/// Attributes subsequently banked sub-span time to `phase`. Called at every
/// top-level phase boundary by `session.rs`.
pub(crate) fn set_phase(phase: PhaseId) {
    update(|collector| collector.phase = Some(phase));
}

fn phase_index(collector: &Collector) -> Option<usize> {
    collector.phase.map(PhaseId::index)
}

/// Entered by [`crate::eval::run`] on every invocation. Timing uses an
/// explicit enter/exit pair (rather than RAII) so the drive loop pays one
/// predictable branch per step instead of a guard drop per step.
pub(crate) fn run_enter() -> RunFrame {
    let mut frame = RunFrame {
        active: false,
        outermost: false,
        start_ms: 0.0,
    };
    update(|collector| {
        frame.active = true;
        collector.run_calls += 1;
        collector.run_depth += 1;
        if collector.run_depth == 1 {
            frame.outermost = true;
            frame.start_ms = now_ms();
        }
    });
    frame
}

#[derive(Clone, Copy)]
pub(crate) struct RunFrame {
    pub(crate) active: bool,
    outermost: bool,
    start_ms: f64,
}

/// Exits a [`run_enter`] frame, banking `steps` drive-loop iterations and,
/// for the outermost frame, the elapsed wall time to the current phase.
pub(crate) fn run_exit(frame: &RunFrame, steps: u64) {
    if !frame.active {
        return;
    }
    update(|collector| {
        collector.eval_steps += steps;
        collector.run_depth = collector.run_depth.saturating_sub(1);
        if frame.outermost
            && let Some(phase) = phase_index(collector)
        {
            collector.sub_ms[SubSpan::Eval.index()][phase] += now_ms() - frame.start_ms;
        }
    });
}

/// Enters a nested timed region. Reentrant entries of the same kind do not
/// bank time (only the outermost level does) and do not double-count calls.
pub(crate) fn enter_span(kind: SubSpan) -> SpanGuard {
    let mut guard = SpanGuard {
        kind,
        start_ms: 0.0,
        entered: false,
        inside_eval: false,
    };
    update(|collector| {
        guard.entered = true;
        let depth = &mut collector.depths[kind.index()];
        *depth += 1;
        if *depth > 1 {
            return;
        }
        guard.start_ms = now_ms();
        match kind {
            SubSpan::Eval => {}
            SubSpan::Conversion => {
                collector.conversion_calls += 1;
                guard.inside_eval = collector.run_depth > 0;
                if guard.inside_eval {
                    collector.conversion_inside_eval_calls += 1;
                } else {
                    collector.conversion_outside_eval_calls += 1;
                }
            }
            SubSpan::Coverage => collector.coverage_calls += 1,
            SubSpan::Ownership => collector.ownership_calls += 1,
            SubSpan::Safety => collector.safety_calls += 1,
        }
    });
    guard
}

pub(crate) struct SpanGuard {
    kind: SubSpan,
    start_ms: f64,
    entered: bool,
    inside_eval: bool,
}

impl Drop for SpanGuard {
    fn drop(&mut self) {
        if !self.entered {
            return;
        }
        let kind = self.kind;
        let start_ms = self.start_ms;
        let inside_eval = self.inside_eval;
        update(|collector| {
            let depth = &mut collector.depths[kind.index()];
            *depth = depth.saturating_sub(1);
            if *depth > 0 {
                return;
            }
            let elapsed = now_ms() - start_ms;
            if let Some(phase) = phase_index(collector) {
                collector.sub_ms[kind.index()][phase] += elapsed;
                if kind == SubSpan::Conversion && inside_eval {
                    collector.conversion_inside_eval_ms[phase] += elapsed;
                }
            }
        });
    }
}

/// Records one Checker-level expression evaluation with its input identity.
pub(crate) fn note_eval_expression_call(
    module: &str,
    expression: u32,
    phase_tag: u8,
    env: &Environment,
) {
    let fingerprint = fingerprint_input(module, None, expression, phase_tag, env);
    update(|collector| {
        collector.eval_expression_calls += 1;
        collector.unique_inputs.insert(fingerprint);
        note_hot_expression(collector, module, expression);
    });
}

/// Records one Checker-level binding evaluation with its input identity.
pub(crate) fn note_eval_binding_call(
    module: &str,
    pattern: u32,
    expression: u32,
    phase_tag: u8,
    env: &Environment,
) {
    let fingerprint = fingerprint_input(module, Some(pattern), expression, phase_tag, env);
    update(|collector| {
        collector.eval_binding_calls += 1;
        collector.unique_inputs.insert(fingerprint);
        note_hot_expression(collector, module, expression);
    });
}

fn note_hot_expression(collector: &mut Collector, module: &str, expression: u32) {
    if collector.hot_expressions.len() >= 4096
        && !collector
            .hot_expressions
            .contains_key(&(module.to_owned(), expression))
    {
        collector.hot_overflow += 1;
        return;
    }
    *collector
        .hot_expressions
        .entry((module.to_owned(), expression))
        .or_insert(0) += 1;
}

/// Records an `evaluated_bindings` cache hit (exact memoization evidence).
pub(crate) fn note_eval_cache_hit() {
    update(|collector| collector.eval_cache_hits += 1);
}

/// Records one closure application entering evaluation.
pub(crate) fn note_closure_application() {
    update(|collector| collector.closure_applications += 1);
}

/// Records one module application entering evaluation.
pub(crate) fn note_module_application() {
    update(|collector| collector.module_applications += 1);
}

/// Records a `reusable_module_results` hit.
pub(crate) fn note_module_result_hit() {
    update(|collector| collector.module_result_hits += 1);
}

/// Records the comptime memo probe outcome for one closure application:
/// whether the closure was memo-eligible and whether the argument converted
/// to a memo key. Uses the evaluator's own conversion, so semantics match.
pub(crate) fn note_memo_probe(eligible: bool, key_built: bool) {
    update(|collector| {
        if eligible {
            collector.memo_eligible += 1;
        }
        if key_built {
            collector.memo_probes += 1;
        }
    });
}

/// Records a comptime memo hit.
pub(crate) fn note_memo_hit() {
    update(|collector| collector.memo_hits += 1);
}

/// Records a comptime memo store attempt after a miss. `inserted` is false
/// when the result cache was already at its entry limit.
pub(crate) fn note_memo_store(value_memoizable: bool, inserted: bool) {
    update(|collector| {
        if !value_memoizable {
            collector.memo_nonmemoizable_results += 1;
            return;
        }
        if inserted {
            collector.memo_stores += 1;
        } else {
            collector.memo_store_dropped_at_limit += 1;
        }
    });
}

/// Records the memo table size after a store; the payload keeps the maximum
/// (exact unique memoizable-input count for the request).
pub(crate) fn note_memo_len(len: usize) {
    update(|collector| {
        collector.memo_unique_max = collector.memo_unique_max.max(len as u64);
    });
}

/// Records a module-result-template instance hit (no reconstruction needed).
pub(crate) fn note_template_hit() {
    update(|collector| collector.template_hits += 1);
}

/// Records an admitted module-result reconstruction.
pub(crate) fn note_reconstruction_admitted() {
    update(|collector| collector.reconstructions_admitted += 1);
}

/// Records a reconstruction declined in favor of full module evaluation.
pub(crate) fn note_reconstruction_fallback() {
    update(|collector| collector.reconstructions_fallback_full_eval += 1);
}

/// Records an admitted reconstruction's decode outcome.
pub(crate) fn note_reconstruction_decoded(ok: bool) {
    update(|collector| {
        if ok {
            collector.reconstructions_decoded_ok += 1;
        } else {
            collector.reconstructions_decoded_err += 1;
        }
    });
}

/// Records one constraint-type interner probe and its hit/miss outcome.
/// Attempts are already visible as `typeInterns`; this splits them.
pub(crate) fn note_intern(hit: bool) {
    update(|collector| {
        if hit {
            collector.intern_hits += 1;
        } else {
            collector.intern_misses += 1;
        }
    });
}

/// Records one top-level structural type comparison.
pub(crate) fn note_same_type() {
    update(|collector| collector.same_type_calls += 1);
}

/// Per-phase sub-span wall milliseconds, indexed by [`PhaseId`] order
/// (preparation, check, facts, preflight).
#[derive(Clone, Copy, Default)]
pub(crate) struct SubMsTable {
    pub(crate) eval: [f64; 4],
    pub(crate) conversion: [f64; 4],
    pub(crate) conversion_inside_eval: [f64; 4],
    pub(crate) coverage: [f64; 4],
    pub(crate) ownership: [f64; 4],
    pub(crate) safety: [f64; 4],
}

/// Copies the sub-span table without the heavier snapshot sections. Returns
/// `None` when no collector is active.
pub(crate) fn sub_ms_table() -> Option<SubMsTable> {
    COLLECTOR.with(|slot| {
        let collector = slot.borrow();
        let collector = collector.as_ref()?;
        let row = |kind: SubSpan| -> [f64; 4] {
            [
                collector.sub_ms[kind.index()][0],
                collector.sub_ms[kind.index()][1],
                collector.sub_ms[kind.index()][2],
                collector.sub_ms[kind.index()][3],
            ]
        };
        Some(SubMsTable {
            eval: row(SubSpan::Eval),
            conversion: row(SubSpan::Conversion),
            conversion_inside_eval: collector.conversion_inside_eval_ms,
            coverage: row(SubSpan::Coverage),
            ownership: row(SubSpan::Ownership),
            safety: row(SubSpan::Safety),
        })
    })
}

/// Drains the active collector into the payload's `eval` and `structural`
/// sections plus per-phase sub-span milliseconds. Returns `None` when no
/// collector is active.
pub(crate) fn snapshot() -> Option<serde_json::Value> {
    COLLECTOR.with(|slot| {
        let collector = slot.borrow();
        let collector = collector.as_ref()?;
        let table = sub_ms_table().unwrap_or_default();
        let sub_ms = |row: [f64; 4]| -> Vec<f64> { row.to_vec() };
        let mut hot: Vec<(&(String, u32), &u64)> = collector.hot_expressions.iter().collect();
        hot.sort_by(|left, right| {
            right
                .1
                .cmp(left.1)
                .then_with(|| left.0.cmp(right.0))
        });
        hot.truncate(8);
        Some(serde_json::json!({
            "eval": {
                "expressionCalls": collector.eval_expression_calls,
                "bindingCalls": collector.eval_binding_calls,
                "cacheHits": collector.eval_cache_hits,
                "uniqueInputs": collector.unique_inputs.len() as u64,
                "uniqueInputSemantics": "distinct lossy input fingerprints over Checker-level eval calls (module, pattern/expression, phase, bounded environment walk); a lower bound on truly distinct inputs, never proof of equality",
                "hotExpressions": hot.iter().map(|((module, expression), calls)| {
                    serde_json::json!({"module": module, "expression": expression, "calls": calls})
                }).collect::<Vec<_>>(),
                "hotOverflow": collector.hot_overflow,
                "runs": collector.run_calls,
                "steps": collector.eval_steps,
                "closureApplications": collector.closure_applications,
                "moduleApplications": collector.module_applications,
                "moduleResultHits": collector.module_result_hits,
                "memoEligible": collector.memo_eligible,
                "memoProbes": collector.memo_probes,
                "memoHits": collector.memo_hits,
                "memoStores": collector.memo_stores,
                "memoStoreDroppedAtLimit": collector.memo_store_dropped_at_limit,
                "memoNonmemoizableResults": collector.memo_nonmemoizable_results,
                "memoUniqueMax": collector.memo_unique_max,
                "conversionCalls": collector.conversion_calls,
                "conversionInsideEvalCalls": collector.conversion_inside_eval_calls,
                "conversionOutsideEvalCalls": collector.conversion_outside_eval_calls,
                "templateHits": collector.template_hits,
                "reconstructionsAdmitted": collector.reconstructions_admitted,
                "reconstructionsDecodedOk": collector.reconstructions_decoded_ok,
                "reconstructionsDecodedErr": collector.reconstructions_decoded_err,
                "reconstructionsFallbackFullEval": collector.reconstructions_fallback_full_eval,
            },
            "structural": {
                "internHits": collector.intern_hits,
                "internMisses": collector.intern_misses,
                "sameTypeCalls": collector.same_type_calls,
                "coverageCalls": collector.coverage_calls,
                "ownershipCalls": collector.ownership_calls,
                "safetyCalls": collector.safety_calls,
            },
            "subMs": {
                "eval": sub_ms(table.eval),
                "conversion": sub_ms(table.conversion),
                "conversionInsideEval": sub_ms(table.conversion_inside_eval),
                "coverage": sub_ms(table.coverage),
                "ownership": sub_ms(table.ownership),
                "safety": sub_ms(table.safety),
            },
        }))
    })
}

// ---------------------------------------------------------------------------
// Input fingerprints
// ---------------------------------------------------------------------------

const FINGERPRINT_MAX_FRAMES: usize = 32;
const FINGERPRINT_MAX_BINDINGS_PER_FRAME: usize = 128;
const FINGERPRINT_MAX_INT_BYTES: usize = 32;
const FINGERPRINT_MAX_TEXT_BYTES: usize = 32;

/// FNV-1a over the 64-bit basis: dependency-free and stable across runs.
struct FingerprintHasher(u64);

impl FingerprintHasher {
    fn new() -> Self {
        Self(0xcbf29ce484222325)
    }

    fn bytes(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }

    fn u8(&mut self, value: u8) {
        self.bytes(&[value]);
    }

    fn u32(&mut self, value: u32) {
        self.bytes(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.bytes(&value.to_le_bytes());
    }

    fn usize(&mut self, value: usize) {
        self.u64(value as u64);
    }

    fn str(&mut self, value: &str) {
        self.usize(value.len());
        self.bytes(value.as_bytes());
    }
}

impl Hasher for FingerprintHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        self.bytes(bytes);
    }
}

fn fingerprint_input(
    module: &str,
    pattern: Option<u32>,
    expression: u32,
    phase_tag: u8,
    env: &Environment,
) -> u64 {
    let mut hasher = FingerprintHasher::new();
    hasher.str(module);
    hasher.u8(u8::from(pattern.is_some()));
    if let Some(pattern) = pattern {
        hasher.u32(pattern);
    }
    hasher.u32(expression);
    hasher.u8(phase_tag);
    fingerprint_env(&mut hasher, env);
    hasher.finish()
}

fn fingerprint_env(hasher: &mut FingerprintHasher, env: &Environment) {
    use std::rc::Rc;
    let mut current: Option<Environment> = Some(env.clone());
    let mut frames = 0usize;
    // A `Weak` cycle through parent links would spin forever; `Rc::ptr_eq`
    // against the chain head bounds even a pathological walk.
    let head = Rc::as_ptr(env) as usize;
    let mut count = 0usize;
    while let Some(frame) = current {
        if frames >= FINGERPRINT_MAX_FRAMES {
            hasher.u8(0xFE);
            return;
        }
        frames += 1;
        let Ok(names) = frame.names.try_borrow() else {
            hasher.u8(0xFD);
            return;
        };
        hasher.usize(names.len());
        for (index, (name, value)) in names.iter().enumerate() {
            if index >= FINGERPRINT_MAX_BINDINGS_PER_FRAME {
                hasher.u8(0xFC);
                break;
            }
            hasher.str(name);
            fingerprint_value(hasher, value);
        }
        drop(names);
        let Ok(parent) = frame.parent.try_borrow() else {
            hasher.u8(0xFB);
            return;
        };
        let next = parent.clone();
        drop(parent);
        if let Some(next) = &next {
            count += 1;
            if Rc::as_ptr(next) as usize == head || count > FINGERPRINT_MAX_FRAMES {
                hasher.u8(0xFA);
                return;
            }
        }
        current = next;
    }
}

/// Shallow value mix: variant tag plus scalar payloads and container shapes.
/// Deep structure is intentionally excluded; see the module docs.
fn fingerprint_value(hasher: &mut FingerprintHasher, value: &Value) {
    match value {
        Value::Int(value) => {
            hasher.u8(1);
            let (sign, bytes) = value.to_bytes_le();
            hasher.u8(match sign {
                num_bigint::Sign::Minus => 0,
                num_bigint::Sign::NoSign => 1,
                num_bigint::Sign::Plus => 2,
            });
            hasher.usize(bytes.len());
            let capped = bytes.len().min(FINGERPRINT_MAX_INT_BYTES);
            hasher.bytes(&bytes[..capped]);
        }
        Value::Float(value) => {
            hasher.u8(2);
            hasher.u64(value.to_bits());
        }
        Value::Float32(value) => {
            hasher.u8(3);
            hasher.u32(value.to_bits());
        }
        Value::Vector(lanes) => {
            hasher.u8(4);
            for lane in lanes {
                hasher.u32(lane.to_bits());
            }
        }
        Value::VectorMask(mask) => {
            hasher.u8(5);
            for lane in mask {
                hasher.u8(u8::from(*lane));
            }
        }
        Value::IntegerVector { bits, lanes } => {
            hasher.u8(6);
            hasher.u8(*bits);
            hasher.usize(lanes.len());
            for lane in lanes.iter().take(8) {
                hasher.u32(*lane as u32);
            }
        }
        Value::IntegerVectorMask { bits, lanes } => {
            hasher.u8(7);
            hasher.u8(*bits);
            hasher.usize(lanes.len());
            for lane in lanes.iter().take(32) {
                hasher.u8(u8::from(*lane));
            }
        }
        Value::Text(value) => {
            hasher.u8(8);
            hasher.usize(value.len());
            let capped = value.len().min(FINGERPRINT_MAX_TEXT_BYTES);
            hasher.bytes(&value.as_bytes()[..capped]);
        }
        Value::Unit => hasher.u8(9),
        Value::Shape(fields) => {
            hasher.u8(10);
            hasher.usize(fields.len());
        }
        Value::Array(values) => {
            hasher.u8(11);
            hasher.usize(values.len());
        }
        Value::RegionType(_) => hasher.u8(12),
        Value::ScratchType(_) => hasher.u8(13),
        Value::ResourceType { family, .. } => {
            hasher.u8(14);
            hasher.str(family);
        }
        Value::Scratch { values, .. } => {
            hasher.u8(15);
            hasher.usize(values.len());
        }
        Value::DeferredScratch { .. } => hasher.u8(16),
        Value::Region { start, end, .. } => {
            hasher.u8(17);
            hasher.usize(*start);
            hasher.usize(*end);
        }
        Value::RegionRejoin {
            start, middle, end, ..
        } => {
            hasher.u8(18);
            hasher.usize(*start);
            hasher.usize(*middle);
            hasher.usize(*end);
        }
        Value::EmptyArray { .. } => hasher.u8(19),
        Value::Tag { name, payload } => {
            hasher.u8(20);
            hasher.str(name);
            hasher.u8(u8::from(payload.is_some()));
        }
        Value::Closure {
            module,
            body,
            self_name,
            deferred,
            ..
        } => {
            hasher.u8(21);
            hasher.str(module);
            hasher.u32(body.0);
            hasher.u8(u8::from(self_name.is_some()));
            if let Some(name) = self_name {
                hasher.str(name);
            }
            hasher.u8(u8::from(*deferred));
        }
        Value::Deferred {
            module, expression, ..
        } => {
            hasher.u8(22);
            hasher.str(module);
            hasher.u32(expression.0);
        }
        Value::ClosureChoice { .. } => hasher.u8(23),
        Value::ModuleClosure { module } => {
            hasher.u8(24);
            hasher.str(module);
        }
        Value::IndexedStep { elements } => {
            hasher.u8(25);
            hasher.usize(elements.len());
        }
        Value::Primitive {
            name,
            arity,
            applied,
            ..
        } => {
            hasher.u8(26);
            hasher.str(name);
            hasher.usize(*arity);
            hasher.usize(applied.len());
        }
        Value::Range { .. } => hasher.u8(27),
        Value::Union(_) => hasher.u8(28),
        Value::Unbounded => hasher.u8(29),
        Value::Arrow {
            deferred, effects, ..
        } => {
            hasher.u8(30);
            hasher.u8(u8::from(*deferred));
            hasher.usize(effects.len());
        }
        Value::TypeVariable(id) => {
            hasher.u8(31);
            hasher.u32(*id);
        }
        Value::Forall { variable, .. } => {
            hasher.u8(32);
            hasher.u32(*variable);
        }
        Value::Effect { id, name, host, .. } => {
            hasher.u8(33);
            hasher.u32(*id);
            hasher.str(name);
            hasher.u8(u8::from(*host));
        }
        Value::Operation { name, .. } => {
            hasher.u8(34);
            hasher.str(name);
        }
        Value::Extended { members, .. } => {
            hasher.u8(35);
            hasher.usize(members.len());
        }
        Value::Sealed { name, .. } => {
            hasher.u8(36);
            hasher.str(name);
        }
        Value::OpaqueType(name) => {
            hasher.u8(37);
            hasher.str(name);
        }
        Value::Runtime(value) => {
            hasher.u8(38);
            hasher.usize(value.id);
            hasher.usize(value.type_id);
        }
        Value::Continuation { .. } => hasher.u8(39),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inactive_hooks_do_not_collect() {
        assert!(!is_active());
        assert!(snapshot().is_none());
        let frame = run_enter();
        assert!(!frame.active);
        run_exit(&frame, 7);
        note_memo_hit();
        note_intern(true);
        note_same_type();
        assert!(snapshot().is_none());
    }

    #[test]
    fn collection_banks_time_and_counters() {
        let guard = activate();
        assert!(is_active());
        set_phase(PhaseId::Check);
        let frame = run_enter();
        assert!(frame.active);
        run_exit(&frame, 11);
        note_memo_probe(true, true);
        note_memo_hit();
        note_intern(false);
        let payload = snapshot().expect("active snapshot");
        assert_eq!(payload["eval"]["runs"], 1);
        assert_eq!(payload["eval"]["steps"], 11);
        assert_eq!(payload["eval"]["memoEligible"], 1);
        assert_eq!(payload["eval"]["memoProbes"], 1);
        assert_eq!(payload["eval"]["memoHits"], 1);
        assert_eq!(payload["structural"]["internMisses"], 1);
        assert!(payload["subMs"]["eval"][1].as_f64().unwrap() >= 0.0);
        drop(guard);
        assert!(!is_active());
    }

    #[test]
    fn nested_runs_bank_time_once() {
        let guard = activate();
        set_phase(PhaseId::Preparation);
        let outer = run_enter();
        let inner = run_enter();
        run_exit(&inner, 3);
        run_exit(&outer, 5);
        let payload = snapshot().expect("active snapshot");
        assert_eq!(payload["eval"]["runs"], 2);
        assert_eq!(payload["eval"]["steps"], 8);
        drop(guard);
    }

    #[test]
    fn fingerprints_distinguish_modules_and_expressions() {
        let env = crate::value::child_env(None);
        let left = fingerprint_input("a.blot", None, 1, 0, &env);
        let other_module = fingerprint_input("b.blot", None, 1, 0, &env);
        let other_expression = fingerprint_input("a.blot", None, 2, 0, &env);
        let other_phase = fingerprint_input("a.blot", None, 1, 1, &env);
        assert_ne!(left, other_module);
        assert_ne!(left, other_expression);
        assert_ne!(left, other_phase);
        assert_eq!(left, fingerprint_input("a.blot", None, 1, 0, &env));
    }
}
