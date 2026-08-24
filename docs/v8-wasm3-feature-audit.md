# V8 and WebAssembly 3 feature audit

## Scope

This audit follows the initial WebAssembly 3 target work. It asks which modern
features materially reduce Blot compiler work or improve emitted-code
performance without weakening source semantics, ABI 1, ownership evidence, or
engine compatibility.

The compatibility snapshot is dated 2026-08-24. Engine and interpreter support
must be rechecked before expanding either target profile.

The review used the WebAssembly feature-status table, proposal specifications,
current V8 feature declarations, wasm-tools support, the wasm3 interpreter's
published matrix, and Blot's Runtime HIR/backend.

## Decision matrix

| Feature                                | Expected payoff for Blot                                | Integration cost/risk                                 | Decision            |
| -------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- | ------------------- |
| tail calls                             | removes recursive target frames and call-result traffic | low after direct-call specialization                  | already adopted     |
| branch hinting                         | better cold-path layout and register allocation in V8   | low; standardized custom metadata                     | adopt now           |
| bulk memory                            | replaces byte-copy loops                                | low and already required by allocator                 | retain              |
| multi-value                            | avoids private result records and reloads               | low and already emitted when needed                   | retain              |
| fixed SIMD                             | native vector arithmetic                                | already represented with deterministic semantics      | retain              |
| typed function references / `call_ref` | can reduce defunctionalized dynamic dispatch            | high until Runtime HIR has residual dynamic calls     | defer               |
| Wasm GC                                | can remove parts of manual object management            | very high; conflicts with Store/root and ABI proofs   | separate profile    |
| JS string builtins / imported strings  | can remove UTF-8 copies for V8-hosted Text              | high; changes Text representation and caller contract | separate V8 profile |
| memory64                               | larger address space                                    | no current workload benefit; ABI is memory32          | defer               |
| multiple memories                      | possible heap/static isolation                          | no measured win; complicates adapters                 | defer               |
| exception handling                     | cheaper catchable control in some languages             | mismatches Blot resumable effects and source traps    | defer               |
| JSPI / stack switching                 | simpler asynchronous host integration                   | requires a new async host protocol                    | separate profile    |
| relaxed SIMD                           | possible fused/target-specific vector speedups          | changes rounding/NaN determinism                      | defer               |

The audit found no additional representation-preserving feature with the same
order-of-magnitude payoff as the already adopted tail calls, bulk memory, and
multi-value lowering. Branch hints are an incremental V8 optimization. The next
larger reductions require a separate Text/GC profile or a genuine residual
dynamic-call representation.

## Adopted follow-up: cold trap hints

Blot already emits defensive conditions whose taken branch immediately executes
`unreachable`. Those branches represent malformed inputs, arithmetic/extent
overflow, impossible ownership states, and compiler-proved invariant guards.
Their normal execution probability is expected to be low by construction.

The backend now derives branch hints from the completed encoded function rather
than duplicating source or Runtime-HIR analysis. Only `if` immediately followed
by `unreachable` receives a likely-false hint. This keeps the optimization
conservative and prevents profile-guided guesses from becoming semantic facts.

The section is optional metadata. Removing it or running on an engine that
ignores it preserves validation and execution behavior. The manifest reports it
under `optimizationFeatures`, not `requiredFeatures`.

## V8 and wasm3 conclusions

V8 is the production performance target and is tested through current Node LTS
and Current lines. The standardized branch-hinting proposal is supported in
current V8-class engines and is designed to improve code layout and register
allocation.

The wasm3 interpreter is not synonymous with WebAssembly 3.0. Its published
feature matrix currently lacks tail calls and fixed SIMD and has only partial
bulk-memory support. Blot therefore treats wasm3 as a possible future restricted
profile, not as evidence that every WebAssembly 3 artifact is portable to that
interpreter.

## Next high-value experiment

The next feature with potentially large work reduction is a separate V8 Text
profile using standardized JS string integration. It could avoid repeated UTF-8
lifting/lowering and some linear-memory allocation, but it changes the
representation relation and host contract. It should be benchmarked as a new
profile rather than mixed silently into Core Wasm ABI 1.

Typed function references become worthwhile only after Runtime HIR admits a real
residual dynamic-call representation. Until then direct calls are smaller,
easier to validate, and easier for V8 to optimize.
