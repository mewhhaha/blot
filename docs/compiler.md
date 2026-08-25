# Compiler host and distribution

Protocol versions and the concise capability inventory are generated from
[`compiler/current-implementation.json`](../compiler/current-implementation.json)
and [`compiler/protocol.json`](../compiler/protocol.json); see the
[current implementation report](../generated/CURRENT_IMPLEMENTATION.md).

Blot has one semantic compiler. It is implemented in Rust, built as Wasm, and
hosted by Node for ordinary commands and library use.

```text
source graph resolved by Node
  -> Rust compiler Wasm session
     -> Baba lexer, layout, and CPU island parser
     -> AST
     -> comptime evaluation and biunification
     -> ownership and safety
     -> Runtime HIR
     -> ABI closure and Wasm emission
  -> WebAssembly + ABI manifest
```

TypeScript owns filesystem and package resolution, syntax-only formatting and
editor services, transport validation, and caller ABI decoding. It does not
contain a fallback checker, evaluator, ownership pass, Runtime-HIR lowerer, or
emitter.

## Versions

| Component |          Version |
| --------- | ---------------: |
| Node      | 22.16.0 or newer |
| pnpm      |          11.21.0 |
| Rust      |           1.97.1 |
| Baba      |            9.0.0 |
| @std/path |            1.1.6 |

## Use it

```bash
corepack enable
pnpm install
pnpm compiler:build
pnpm blot check examples/minimal.blot
pnpm blot run examples/minimal.blot
pnpm blot build examples/minimal.blot
pnpm test
```

`run` invokes a zero-parameter default or sole runtime export and decodes its
canonical ABI result. Programs that need host capabilities must be embedded in a
host that implements them.

Library consumers use the same resident compiler:

```ts
import { Compiler } from "@mewhhaha/blot/compiler";

const compiler = await Compiler.create();
try {
  const checked = await compiler.check("examples/minimal.blot");
  const analysis = await compiler.analyze("examples/minimal.blot");
  const hir = await compiler.prepare("examples/minimal.blot");
  const artifact = await compiler.compile("examples/minimal.blot");
  console.log(checked.type, analysis.ownership.length, hir.schemaVersion);
  console.log(WebAssembly.validate(artifact.wasm));
} finally {
  compiler.destroy();
}
```

The host resolves and configures the complete source graph in one Rust session.
Rust source diagnostics become located `BlotError`s, resource bounds become
`CompilerLimitDiagnostic`, target refusals remain `CompilerTargetRefusal`, and
post-check invariant failures remain `CompilerInvariantFailure`.

## Compiler distribution

`generated/compiler/compiler.wasm` is derived and ignored by Git. Its adjacent
manifest is schema version 2 and binds the bytes to:

- the compiler host ABI version;
- the generated prelude snapshot digest;
- a deterministic digest of every Rust compiler input;
- the pinned Rust toolchain and Git provenance.

`Compiler.create()` requires the Wasm, manifest, and prelude snapshot and
validates the byte digest, host ABI, and prelude digest before instantiation. It
never invokes Cargo and never falls back to TypeScript. A custom Wasm passed to
`Compiler.create` must include its matching prelude snapshot; that explicit pair
is a caller-owned trusted distribution.

Build the bundle locally with:

```bash
pnpm compiler:build
```

Or download the artifact from a successful CI run for the same compiler-input
closure:

```bash
pnpm compiler:download
```

The download additionally validates the complete compiler-input digest before
installing anything.

## Host ABI

Compiler-host ABI 3 registers UTF-8 paths once and refers to them through stable
session-local `ModuleId` values. Changed UTF-8 source or compact AST bytes,
resolved import edges, included bytes, and removals travel in validated batched
binary delta frames. Trusted compiler-distributed snapshots use a separate
installation operation after manifest validation and cannot enter a generic
delta. UTF-8 decoding reconstructs the frontend's UTF-16 offset space, so source
spans retain their documented units without copying one 32-bit word per source
unit. Successful checks return compact binary summaries; full diagnostics and
requested analysis facts remain available in the same versioned response
envelope.

The compiler also exports session operations for evaluation, tagged test
execution, canonical AST export, Runtime-HIR preparation, and compilation.
Transport failures preserve the compiler's three public classes:

- located source diagnostics;
- explicit target refusals;
- compiler invariant failures.

Analysis facts are request-local. Editor hovers consume span/type facts,
`blot ownership` consumes last-use and spent-binding facts, and `blot test`
executes Rust-discovered declaration tags. These facts are observations of the
Rust check, not a second host analysis.

The compiler-distributed prelude snapshot contains the Rust AST and checked
certificate. The host installs it through the explicitly trusted operation under
the ordinary resolved prelude path. Package capsules are different: package
format 4 stores canonical AST JSON exported by Rust, but consumers still check
and specialize that graph normally.

## Caching

The Node host keys a resident source graph by portable syntax, dependencies, and
included bytes. The Rust session owns semantic caches and invalidates a changed
module together with its importers. Runtime HIR and artifacts are copied at the
public boundary so caller mutation cannot poison the cache.

## Conformance and benchmark

`pnpm conformance` compares the Rust evaluator with emitted Wasm on the focused
runtime corpus. Rust unit tests and the executable source catalog cover
checking, diagnostics, ownership, staging, and lowering contracts.

`pnpm run benchmark -- <root.blot>` compares the high-level host adapter with
the direct compiler-Wasm transport. Both routes execute the same semantic
implementation; the comparison measures host overhead and first confirms that
Runtime HIR and ABI artifacts are identical.

`pnpm benchmark:compiler-profiles` compares release profiles `s`, `2`, and `3`
under identical LTO, codegen-unit, panic, strip, and stack controls. It records
artifact and shipped compiler-payload bytes, compile/instantiate time, fresh and
incremental checks, type-scaling work, prepare/emission time, and a 10,000-edit
memory soak. The checked-in
[profile decision](../experiments/compiler-profile-decision.md) keeps
`opt-level = "s"` from the latest raw matrix; scheduled runs record wall time
without making it an ordinary pull-request gate.

`pnpm benchmark:compiler-startup` decomposes direct semantic-core fresh-process
startup through a completed check. The unified benchmark's cold boundaries
measure the public host. `pnpm benchmark:compiler-suite` runs 31 samples in each
of three independent runs over the minimal, terminal, and agent workloads;
`pnpm benchmark:compiler-compare` requires every candidate target-run median to
improve by 10% against the aggregate baseline, rejects significant 5%
regressions, requires comparable provenance, and requires public observations
and deterministic compiler work to remain exact.

On 2026-08-25, a stable-path host comparison against `bf8143a`, holding the
compiler artifact constant, reduced the cold-compiler median from 59.415 to
33.479 ms for minimal, 61.538 to 36.039 ms for terminal, and 63.261 to 39.570 ms
for agent. The primary improvement was 43.7%; its independent runs improved by
43.7%, 45.7%, and 42.6%, with no significant measured-boundary regression above
5%.

## CI boundary

CI builds the compiler bundle once with the pinned toolchain, uploads those
exact bytes, and uses them for TypeScript checks, Node and regression tests,
conformance, package tests, smoke builds, and benchmarks. The runnable workspace
contains the same Wasm, manifest, and prelude snapshot. Compiler commands never
initialize WebGPU or invoke a native toolchain at runtime.
