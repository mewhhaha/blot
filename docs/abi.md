# Core WebAssembly ABI

## Status

This document is the normative byte-level and caller-ownership contract for Blot
Core Wasm ABI 3. [`spec/RUNTIME.md`](../spec/RUNTIME.md) owns the semantic
source-to-caller representation relation and public-type admissibility. The
section **Runtime target status** below records current implementation coverage;
it cannot weaken an ABI rule for an artifact the compiler accepts.

The generated
[current implementation report](../generated/CURRENT_IMPLEMENTATION.md) records
the current ABI version and public capability inventory.

`blot build` publishes a stable Core WebAssembly interface. It does not expose
Runtime HIR's private Store, sum, or closure layouts. Generated adapters lift
caller values into that private representation and lower results back out.

The current contract is Blot Core Wasm ABI 3.0. A compatible compiler may add
manifest fields or exports that do not change an existing declaration. Changing
a function signature, layout, ownership rule, import name, or value meaning
requires a new ABI major.

The source-to-caller representation relation and its proof obligations are in
[`spec/RUNTIME.md`](../spec/RUNTIME.md); this document is the normative byte
contract.

## Module contract

Every artifact exports:

- `memory`, a memory32 linear memory;
- `cabi_realloc(old_pointer, old_size, alignment, new_size) -> pointer`;
- `cabi_enter()` and `cabi_leave()` to bracket caller allocations and their use;
- immutable globals `blot:abi-major` and `blot:abi-minor`; and
- one function named `blot:<source-name>` per runtime module export.

A module whose result is a record exports one function per runtime field, under
that field's name. A module whose result is anything else has one export whose
source name is `default`, so the function is `blot:default`.

An export with an indirect result also exports
`cabi_post_blot:<source-name>(result_pointer)`. The caller must invoke it once,
after it has finished reading that result.

Host effects import operations from `blot:host/<capability>` under the manifest's
`name`. `sourceName` records the source operation name; `operation` identifies
one concrete specialization. A monomorphic operation uses its source name for
all three. Additional specializations receive distinct import names. They use
the same value layouts and flattening rules as exports.
An import's checked `contract.suspends` distinguishes synchronous calls from
requests issued by the suspension protocol below. A suspending operation must
never be invoked through its direct import stub.

## Portable suspension

An export has `execution: "direct"`, `"resumable"`, or `"comptime"`. A
resumable export retains its canonical flat parameters but returns an `i32`
context pointer instead of its source result. Starting it allocates a frame;
it does not run the computation. Source results keep their canonical memory
layout, including scalars and Unit.

The context occupies 24 bytes, aligned to 16. Its memory32 words are: a private
frame reference at offset 0, status at 4, manifest import ordinal at 8, canonical
argument block pointer at 12, pending canonical result pointer at 16, and final
canonical result pointer at 20. The caller must not inspect or modify the frame
reference. Status is 0 (runnable), 1 (waiting), 2 (completed), 3 (cancelled),
4 (yielded), or 5 (released). Requests contain no backend-private value encoding.
An argument block lays out parameters in declaration order, aligning each to
its canonical alignment. The result destination is compiler allocated; the host
may use `cabi_realloc` for its nested buffers.

Development requests share this frame layout. Ordinals below `imports.length`
select host operations; remaining ordinals index `links`. Each link declares
mandatory Boolean `suspends`, agreeing with the provider export's execution
mode. A suspending link is executed through the scoped canonical adapter and
never through its direct import stub. Linked calls inherit the caller's explicit
scope, cancellation, and execution authority; an artifact is retained until
affected work and its cleanup drain.

- `blot:poll(context, maximum_blocks) -> status` accepts runnable or yielded
  contexts and executes at most that many frame segments. Zero immediately
  yields. It runs nested calls through a trampoline without keeping a Wasm
  stack alive across host suspension.
- On status 1 the host copies arguments, executes the declared operation, and
  writes its valid canonical result at offset 16's destination. It then calls
  `blot:resume(context)` to make the waiting frame runnable.
- On status 2 the host copies the final value from offset 20's destination.
- `blot:cancel(context)` invalidates unfinished frame execution. This initial
  protocol supports compiler-managed memory reclamation; it does not imply
  arbitrary guest finalizers or owned external-resource cleanup.
- `blot:release(context)` accepts only completed or cancelled contexts, ends
  their allocation lifetime, and must be called exactly once. Released context
  pointers and pending completions cannot be reused.

Callers bracket argument allocation, execution, result copying, and release
with balanced `cabi_enter`/`cabi_leave`. Allocations remain live while any context
or caller bracket remains open; leaving the last one reclaims that allocation
region. Multiple suspended invocations may coexist. Pure synchronous calls
retain their existing direct adapters and result post-return operations.

Compiled source closures use `callback` descriptors with `entry`, a logical
`function` signature, and a canonical `environment` record. Only the environment
occupies memory or flat lanes; an entry is fixed by the checked descriptor, never
chosen by a guest-supplied code pointer. The manifest's `callbacks` list records
each synthetic `blot:callback:<id>` start adapter and its complete signature:
one logical source argument followed by capture parameters in environment order.
Callback starts always return suspension contexts, including pure callbacks.
Their direct callees also have framed versions so polling remains bounded;
ordinary pure exports retain direct adapters. Tail calls reuse a frame sized for
all tail-reachable callees while preserving its parent continuation.

A host can reuse a precompiled `WebAssembly.Module` after validating its embedded
manifest against the supplied sidecar. Worker submission transfers that module
once per worker, then sends a checked callback entry and canonical captures.
Every worker instance has its own private linear memory. The private-value
executor refuses resource and callback captures rather than copying opaque
identities into another runtime. It instantiates a fresh private heap after a
trap and never retries the failed job.

The host copies captures before returning from the requesting operation and
publishes a scope-owned one-shot handle. It must not call a consumed or revoked
handle, return a callback to guest code, or move a callback beyond the artifact's
scope. Moving a handle revalidates all captured resource leases in its destination
scope. This boundary does not serialize compiler values, source text, or a guest
private heap. Callback starts accept at most 16 flattened parameters.

The host adapter supplies an `AbortSignal` to each operation, observes caller
cancellation before polling and after host completion, and drains outstanding
host operations before releasing their context. An operation must cooperate
with its signal for prompt cancellation. `Spark.scope` supplies structured job
lifetimes through ordinary host effects. Registered source cleanup callbacks
run after children and acquisitions drain, in reverse registration order with
host disposers. Cleanup receives a masked child scope that can use still-live
ancestor leases. Closing an artifact retains its callback entries until cleanup
finishes. A Wasm trap invalidates the artifact and skips guest finalizers while
host resource disposal continues. Speculation and worker execution require
additional scheduling contracts beyond this suspension protocol.

`@text.len`, `@text.of_int`, `@text.cmp`, and `@text.contains` are implemented
in the artifact. They do not create a `Text` import. Text comparison is
lexicographic by Unicode scalar value. Containment searches the UTF-8
representation; valid UTF-8 preserves textual substring boundaries.

## Core signatures

ABI 3 uses the memory32, UTF-8 subset of the WebAssembly Component Model
Canonical ABI for values. Direct signatures use these rules:

- at most 16 flat parameters;
- at most one flat result;
- excess parameters become one pointer to their canonical record layout;
- excess results become one returned pointer for exports;
- an imported excess result adds a final result pointer parameter and returns
  nothing.

The flat core types are:

| Blot value | Flat core values                                  |
| ---------- | ------------------------------------------------- |
| `()`       | none                                              |
| `Int`      | `i64`                                             |
| `F32`      | `f32`                                             |
| `F64`      | `f64`                                             |
| `Bool`     | `i32`, restricted to 0 or 1                       |
| `Text`     | `i32` pointer, `i32` UTF-8 byte length            |
| array      | `i32` pointer, `i32` element count                |
| record     | its fields in canonical order                     |
| variant    | `i32` discriminant followed by the joined payload |
| seal       | its carrier                                       |
| resource   | opaque `i64` token                                |

`F32x4` and `F32x4Mask` remain private computation types. An export or host
operation that mentions either is refused with `BLOT_VECTOR_AT_BOUNDARY`.

Variant payload slots join `i32` and `f32` as `i32`; other mismatched core types
join as `i64`. Missing payload slots are zero.

A resource has manifest shape
`{ "kind": "resource", "name": "Family", "payload": { "kind": "unit" } }`,
size 8 and alignment 8. Its positive token belongs to the explicit host runtime
registry; it is neither an address nor an external handle supplied by source.
The payload is a type parameter with no stored bytes. The host validates the
declared family and payload type, runtime, live ownership scope, and
ancestor relationship at every boundary. Tokens are never reused, and a
completion carrying a revoked token is rejected. A conforming caller cannot
fabricate or substitute resource tokens. The JavaScript adapter exposes frozen
opaque objects instead of token integers.

A seal is nominal inside Blot but transparent at the caller byte boundary. Its
manifest type records the public name and carrier, so conforming tooling and the
representation relation distinguish source contracts. Equal raw Core Wasm
carrier values do not dynamically contain that name. ABI nominal safety
therefore depends on the declared manifest and the conforming-caller premise;
the byte layout alone cannot prevent a hostile caller from confusing equal
carriers.

## Memory layouts

All integers are little-endian.

| Value  | Alignment | Size |
| ------ | --------: | ---: |
| `()`   |         1 |    0 |
| `Bool` |         1 |    1 |
| `F32`  |         4 |    4 |
| `Int`  |         8 |    8 |
| `F64`  |         8 |    8 |
| `Text` |         4 |    8 |
| array  |         4 |    8 |

A text or array header stores its pointer at offset 0 and its byte length or
element count at offset 4.

Record fields are sorted by source field name. Each field starts at the next
multiple of its alignment; the record size is rounded to the record's maximum
alignment.

Variant cases are sorted by source constructor name. Their zero-based position
is the discriminant. The discriminant occupies one byte through 256 cases, two
bytes through 65,536 cases, and four bytes above that. The payload begins at the
next multiple of the largest payload alignment. All cases share the largest
payload size.

Array elements use the element's canonical size and alignment consecutively.
Nested strings, arrays, records, and variants recursively use these rules.

## Ownership

Parameters are borrowed for the duration of a call. The callee never releases
caller-owned parameter memory.

Results are owned by the caller until post-return:

1. call the export;
2. read or copy the result;
3. call its declared `cabi_post_*` export exactly once.

Post-return recursively releases nested text and array buffers and then the
indirect result record. Direct scalar results need no post-return.

Hosts returning an indirect imported result write into the result pointer
provided by the module. They allocate nested buffers with the module's
`cabi_realloc`. The module consumes and releases those buffers before the
enclosing synchronous export call completes.

This memory ownership is distinct from an operation's source ownership contract.
Every host import declares `contract.input`, `contract.result`, and a Boolean
`contract.suspends`. Each ownership summary
summary is `unrestricted`, `affine`, or `linear`, or an exact recursive
record/variant summary whose leaves use those modes. A consuming input transfers
the corresponding Blot authority to the host; an affine or linear result
transfers a fresh obligation to the module. The host must obey this logical
protocol even when the carrier is a scalar or points into memory that remains
borrowed only for the call.

`cabi_realloc` accepts alignments 1, 2, 4, 8, and 16. A zero new size releases a
nonzero old pointer and returns zero. Invalid alignment, size, pointer, UTF-8,
boolean, variant discriminant, or array length traps.

Every artifact the compiler accepts must perform the required validation for its
admitted public types before constructing a Blot value. If the production target
cannot validate one required input class, public-layout construction must refuse
that signature rather than emit an unchecked adapter.

## Manifest

The exact pretty-printed JSON sidecar is also stored in the `blot:abi` custom
section. A host can read it with
`WebAssembly.Module.customSections(module, "blot:abi")`.

The manifest records:

- format `blot-core-wasm`;
- ABI major and minor;
- `coreSpecification`, currently `3.0`;
- a sorted `requiredFeatures` list for every non-MVP instruction family present
  in the artifact;
- a sorted `optimizationFeatures` list for semantically ignorable target
  metadata;
- memory, encoding, flattening limits, and allocator export;
- runtime and compile-time source exports;
- canonical function types and post-return names;
- effects and export result ownership; and
- canonical host import modules, names, function types, and exact input/result
  ownership contracts.

A development-unit manifest may additionally contain `links`. Each entry names
the provider unit, its compiler-generated `blot:dev:*` export, the corresponding
`blot:dev/<unit>` import module, and the canonical function type. These names
are private to one successful development build and are not a stable package or
production ABI. Production artifacts omit `links`.

Development units retain ABI 3's one-memory module contract, so linked units do
not import or share memories. A development host copies parameters and results
recursively through canonical layouts, calls an indirect result's post-return
export after copying, and never exposes one unit's pointers to another. The
source ownership contract remains distinct from these temporary canonical
copies.

The sidecar and custom-section bytes are identical, including the final newline.
The canonical type tree contains record field names, variant case names, and
seal names, so compatibility is structural under the declared contract rather
than dependent on private constructor numbers.

## Runtime target status

This section is operational status, not a relaxation of ABI 3.

Ordinary semantic analysis also runs public-layout preflight without emitting a
Wasm binary. Its `targetPreflight` fact records whether the inferred boundary is
supported and, on refusal, the export name, inferred type, unsupported
component, stable `BLOT_TARGET_REFUSAL` code, and concrete alternatives. Editor
diagnostics and `blot build` therefore consult the same Rust layout planner.
Target refusal remains distinct from a source type error.

The production Rust/Wasm path runs the validated CI-built compiler. One
`ClosedProgram` owns the checked and staged Runtime HIR and one `PublicLayout`
derives both the canonical ABI manifest and the adapters emitted by the direct
Rust backend. Gpupaper is not part of the production ABI path. The current
target implements dynamic direct scalar parameters and results, direct scalar
host imports, closed composite results, and the canonical dynamic `Text`
calculus used by the terminal case study. A `Text` host result uses an indirect
result header, is range- and UTF-8-validated before observation, and may flow
through comparison, concatenation, control, and later `Text -> Unit` host calls.
Generated unit-payload control sums remain internal. Direct-result calls restore
their allocation checkpoint before returning. Closed composite calls permit one
outstanding result: the matching `cabi_post_*` restores the call's allocation
checkpoint in constant time. Reentry, a wrong root pointer, a post-return for
another export, and double post-return trap.

Runtime HIR schema 6 retains private `indirect` roots for positive recursive
algebraic values. Their targets live in the current export call's scratch arena
and recursive edges are memory32 pointers. ABI 3 defines no caller encoding for
such a root: it is admitted only as an internal value whose eventual public
observation has a supported non-recursive type. Public-layout construction
rejects any signature that exposes it.

Schema 6 also retains private Scratch values as a memory32 pointer, initialized
length, and capacity. Scratch has no ABI 3 caller encoding and is rejected in
public signatures and initialized public aggregates; only a finished Array may
cross the boundary.

Schema 6 retains residual float-vector shuffle operations. Their immediate lane
selectors are represented by four dominating private `integer-32` constants;
this changes no public ABI layout because vectors and masks remain private.

Schema 6 adds normalized ownership contracts to capability operations. Runtime
HIR validation requires one operation input type and checks every structural
ownership summary against the exact product or sum fields of that type before
the ABI manifest is constructed.

Multiple input paths are prepared independently and their admitted Runtime HIR
modules form one stable target batch. Blot sends their generic Wasm plans
sequentially through one shared Rust/WebAssembly instance. Returned Wasm byte
arrays are owned and retain input order. A source preparation failure is
reported for that path and excluded before emission. An emitter failure discards
completed sibling misses and returns no admitted miss artifact. Batching changes
compiler scheduling only and never executes a declared host effect.

The host adapter admits canonical scalar and aggregate values and at most 16
flat parameters. It admits affine canonical transfers and refuses split units
and linear host transfers without a supported registered cleanup protocol.
The direct path permits only one outstanding indirect result; resumable calls
have separate result destinations. For every boundary the compiler
does accept, all ABI-required range, representation, UTF-8, discriminant,
boolean, pointer, extent, and ownership checks applicable to that signature must
be present. Accepting an unchecked boundary is an invariant failure.

## JavaScript example

```js
const module = await WebAssembly.compile(bytes);
const manifestBytes = WebAssembly.Module.customSections(module, "blot:abi")[0];
const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));

let memory;
const instance = await WebAssembly.instantiate(module, {
  "blot:host/Console": {
    write(pointer, length) {
      const bytes = new Uint8Array(memory.buffer, pointer, length);
      console.log(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    },
  },
});
memory = instance.exports.memory;

instance.exports["blot:default"]();
```
