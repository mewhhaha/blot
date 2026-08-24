# V8 and WebAssembly 3.0 target profile

## Status

Blot's production target is standard WebAssembly 3.0, tested on V8 through the
current Node LTS and Current release lines. Core Wasm ABI 1 remains memory32.
This document records target selection and implementation status; semantic and
byte-level authority remain in `spec/RUNTIME.md` and `docs/abi.md`.

The similarly named `wasm3` project is an interpreter, not the WebAssembly 3.0
specification. Its current feature set is substantially smaller than the V8
profile. Blot reports exact required features so a host can reject an artifact
before attempting execution.

## Emitted feature contract

The ABI manifest separates semantic requirements from ignorable optimization
metadata:

```json
{
  "abi": {
    "coreSpecification": "3.0",
    "requiredFeatures": ["bulk-memory", "tail-call"],
    "optimizationFeatures": ["branch-hinting"]
  }
}
```

Both lists are sorted and artifact-specific. `requiredFeatures` names
instructions or validation rules needed to execute the artifact.
`optimizationFeatures` names standardized metadata that an engine may ignore
without changing behavior. `WebAssembly.validate` remains authoritative for a
concrete engine.

| Feature                       | Current policy                                                        | Reason                                                                              |
| ----------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| bulk memory                   | always emitted                                                        | `cabi_realloc` and persistent copies use `memory.copy`                              |
| multi-value                   | internal, when needed                                                 | removes tuple result records and reloads                                            |
| fixed SIMD                    | emitted for supported vector source operations                        | preserves the existing deterministic vector semantics                               |
| tail calls                    | exact internal direct tail position, including empty forwarding joins | removes recursive frames and call-result local traffic                              |
| branch hinting                | cold immediate-trap branches                                          | improves V8 layout/register decisions without changing validation or observations   |
| typed references / `call_ref` | deferred                                                              | residual known choices already become direct calls; open closures are refused       |
| GC / JS string builtins       | separate future V8 profile                                            | can remove Text/runtime work but replaces Store and ABI representation proofs       |
| memory64                      | deferred                                                              | ABI 1 is memory32 and current programs gain no offset-space benefit                 |
| multiple memories             | deferred                                                              | no measured benefit yet; complicates canonical adapters and interpreter portability |
| exception handling / JSPI     | separate future async profile                                         | Blot effects are resumable and ABI 1 host calls are synchronous                     |
| relaxed SIMD                  | deferred                                                              | relaxed/FMA instructions can change deterministic floating-point results            |

## Branch-hint lowering

The emitter scans each completed function body and adds a standardized
`metadata.code.branch_hint` entry only for this exact instruction shape:

```text
condition
if
  unreachable
end
```

The hint value is `0`: the trapping branch is expected not to be taken. This
covers allocator overflow, malformed ABI input, ownership protocol misuse, UTF-8
failure, and other defensive checks already represented as immediate traps.
Ordinary source conditionals and non-trapping control flow receive no guessed
probability.

The custom section appears once and before the code section, as required by the
branch-hinting proposal. Removing the section produces the same source and ABI
observations. An engine that ignores the section remains compatible; a V8 engine
may use it for code layout and register allocation.

## Tail-call lowering

For an internal Runtime-HIR block:

```text
r = call.direct f(args)
return r
```

lowering emits `return_call f` only when the call is the final operation and its
result reaches the function return directly or through a cycle-free chain of
empty forwarding blocks. Target, caller, argument, and result layouts must
agree. Any intervening operation, condition, trap, or cycle disables the
optimization.

The optimization applies to self recursion and mutual recursion. It does not
apply across a public export wrapper because that wrapper must execute
allocation checkpoint restoration, canonical lowering, and post-return
bookkeeping.

Tail calls remove caller frames from target stack traces. Stack traces are not a
Blot source observation, so this target difference is admissible and is recorded
for debugging tools.

## V8 matrix

CI performs the dedicated target test without experimental flags on:

- Node 24.19.0 LTS; and
- Node 26.7.0 Current.

The test validates the module, checks required and optimization feature
metadata, confirms the branch-hint custom section is present, instantiates it,
and executes 250,000 recursive tail calls. Failure to emit `return_call` would
ordinarily exhaust the Wasm stack long before completion.

These runs establish unflagged validation and execution for the emitted profile.
They are compatibility tests, not a claim that a particular optimization tier
must use every hint.

## wasm3 interpreter boundary

The wasm3 interpreter's current README reports:

- multi-value support;
- partial bulk-memory support;
- multiple memories and reference types as work in progress; and
- no tail-call optimization, fixed-width SIMD, exception handling, or stack
  switching.

Therefore current Blot artifacts are not generally wasm3-interpreter compatible.
An artifact requiring `tail-call` or `simd` must be rejected by that host.
Branch hints do not add an incompatibility because they are carried in an
ignorable custom section.

A future wasm3-compatible target profile would have to suppress unsupported
instructions, define the performance consequences explicitly, and run wasm3 in
CI. Blot does not silently replace `return_call` with ordinary recursion because
that would remove the constant-target-stack guarantee advertised by the current
V8 profile.

## Admission rule for further features

A modern Wasm feature is adopted when all of these hold:

1. the source observation and determinism effect is explicit;
2. Runtime HIR and validation record the required premise;
3. the ABI and ownership consequences are specified;
4. the manifest distinguishes required behavior from optional metadata;
5. V8 execution and a fallback or refusal path are tested; and
6. benchmark evidence shows material work reduction or performance improvement.

This rule admits branch hints because they are standardized, semantically
ignorable, automatically derivable from cold traps, and supported by the V8
matrix. It defers representation-changing features until their larger benefit
justifies a separate target and ABI proof.
