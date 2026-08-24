# V8 and WebAssembly 3.0 target profile

## Status

Blot's production target is standard WebAssembly 3.0, tested on V8 through the
current Node LTS and Current release lines. Core Wasm ABI 1 remains memory32.
This document records target selection and implementation status; semantic and
byte-level authority remain in `spec/RUNTIME.md` and `docs/abi.md`.

The similarly named `wasm3` project is an interpreter, not the WebAssembly 3.0
specification. Blot keeps a scalar subset compatible with its currently reported
ready features where practical, but V8 is the production performance target.

## Emitted feature contract

The ABI manifest contains:

```json
{
  "abi": {
    "coreSpecification": "3.0",
    "requiredFeatures": ["bulk-memory", "tail-call"]
  }
}
```

`requiredFeatures` is sorted and artifact-specific. It is an early diagnostic
aid; `WebAssembly.validate` remains authoritative for a concrete engine.

| Feature                       | Current policy                                  | Reason                                                                                 |
| ----------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| bulk memory                   | always emitted                                  | `cabi_realloc` and persistent copies use `memory.copy`                                 |
| multi-value                   | internal, when needed                           | removes tuple result records and reloads                                               |
| fixed SIMD                    | emitted for supported vector source operations  | preserves the existing deterministic vector semantics                                  |
| tail calls                    | emitted for exact internal direct tail position | removes recursive frames and call-result local traffic                                 |
| typed references / `call_ref` | deferred                                        | residual known choices already become direct calls; open closures are refused          |
| GC                            | deferred                                        | would replace the Store, ownership, reuse, and ABI representation proof                |
| memory64                      | deferred                                        | ABI 1 is memory32 and current programs gain no offset-space benefit                    |
| multiple memories             | deferred                                        | no measured benefit yet; it complicates canonical adapters and interpreter portability |
| exception handling            | deferred                                        | Blot algebraic effects are resumable and source traps are not catchable exceptions     |
| relaxed SIMD                  | deferred                                        | relaxed/FMA instructions can change deterministic floating-point results               |

## Tail-call lowering

For an internal Runtime-HIR block:

```text
r = call.direct f(args)
return r
```

lowers to:

```text
args
return_call f
```

only when the call is the final operation, the returned value is that exact
operation result, the target is an internal function, and the caller, operation,
and callee have equal flattened result layouts. Argument layouts are checked as
well.

The optimization applies to self recursion and mutual recursion. It does not
apply across a public export wrapper because that wrapper must execute
allocation checkpoint restoration, canonical lowering, and post-return
bookkeeping.

Tail calls remove caller frames from target stack traces. Stack traces are not a
Blot source observation, so this target difference is admissible and is recorded
for debugging tools.

## V8 matrix

CI performs the dedicated target test without experimental flags on:

- Node 24.19.0, using V8 13.6; and
- Node 26.7.0, using V8 14.6.

The test validates the module, checks the manifest feature contract,
instantiates it, and executes 250,000 recursive tail calls. Failure to emit
`return_call` would ordinarily exhaust the Wasm stack long before completion.

V8 already optimizes direct, indirect, reference, and tail-call forms. Blot
still prefers direct calls after specialization because they are the strongest
and cheapest representation of a known target.

## wasm3 interpreter subset

The wasm3 interpreter currently reports bulk memory, multi-value, typed function
references in part, and tail-call optimization as ready. It reports multiple
memories, exception handling, and memory64 as work in progress, and fixed-width
SIMD and GC as unavailable.

Consequently:

- scalar Blot artifacts that require only bulk memory, multi-value, and tail
  calls are intended to remain within wasm3's reported feature subset;
- SIMD artifacts are V8-class artifacts and are not wasm3-compatible; and
- Blot does not make memory64, multiple memories, EH, or GC baseline
  requirements.

The repository does not currently run wasm3 in CI. Compatibility with that
interpreter is therefore a declared subset goal, not a tested production
theorem.

## Admission rule for further features

A modern Wasm feature is adopted when all of these hold:

1. the source observation and determinism effect is explicit;
2. Runtime HIR and validation record the required premise;
3. the ABI and ownership consequences are specified;
4. the manifest reports the exact requirement;
5. V8 execution and a fallback/refusal path are tested; and
6. benchmark evidence shows material work reduction or performance improvement.

This rule favors tail calls now, keeps existing bulk-memory/multi-value/SIMD
use, and avoids representation rewrites whose benefit is currently speculative.
