# Compiler development and production

Node/TypeScript is Blot's default compiler development environment. The
checked-in Rust compiler Wasm is the production implementation. Both implement
the same compiler contract and are kept in strict observable parity. The Node
pipeline is:

```text
source
  -> Baba generated Wasm lexer for layout boundaries
  -> Blot layout elaboration
  -> Baba generated Wasm lexical acceptance
  -> Baba general-profile CPU island parser
  -> Blot TypeScript semantics
  -> validated Runtime HIR
  -> gpupaper Core
  -> gpupaper embedded Rust/Wasm emitter
  -> WebAssembly + ABI manifest
```

Baba owns lexing and parsing. Blot checks, evaluates the compile-time fragment,
proves ownership, stages the program, and exports Runtime HIR. The
compiler-owned backend lowers Runtime HIR through gpupaper Core; gpupaper owns
final Wasm planning and emission. Ordinary Node development uses no Deno
runtime, native Rust toolchain, Cargo process, WebGPU device, or handwritten
parser.

The source trees intentionally use the same phase vocabulary:

| Phase       | Node development            | Rust production                          |
| ----------- | --------------------------- | ---------------------------------------- |
| frontend    | `src/compiler/frontend.ts`  | `compiler/src/frontend.rs` + `source.rs` |
| typecheck   | `src/compiler/typecheck.ts` | `compiler/src/typecheck.rs`              |
| Runtime HIR | `src/compiler/hir.ts`       | `compiler/src/hir.rs`                    |
| backend     | `src/compiler/backend.ts`   | `compiler/src/backend.rs`                |
| session     | `src/compiler/session.ts`   | `compiler/src/session.rs`                |

Feature work should start in the Node phase that owns the behavior, then be
ported to the correspondingly named Rust phase before it is production-complete.

## Versions

| Component |          Version |
| --------- | ---------------: |
| Node      | 22.16.0 or newer |
| pnpm      |          11.21.0 |
| Baba      |            9.0.0 |
| gpupaper  |            0.1.6 |
| @std/path |            1.1.6 |

The pnpm workspace applies a seven-day minimum release age and excludes the two
`@mewhhaha` packages, whose coordinated releases may need immediate testing.

## Use it

```bash
corepack enable
pnpm install
pnpm blot check examples/minimal.blot
pnpm blot run examples/minimal.blot
pnpm blot build examples/minimal.blot
pnpm test
```

`run` compiles in memory and invokes a zero-parameter default (or sole) runtime
export. It copies and prints Unit, scalar, Text, array, record, variant, and
sealed results, then performs the ABI post-return exactly once for owned
indirect values. Programs that require host capabilities must be embedded in a
host that implements those operations.

`build` writes `examples/minimal.wasm` and `examples/minimal.wasm.json`. The
sidecar bytes match the `blot:abi` custom section embedded in the module.

Library consumers use the same resident compiler:

```ts
import { Compiler } from "@mewhhaha/blot";

const compiler = await Compiler.create();
try {
  const artifact = await compiler.compile("examples/minimal.blot");
  console.log(WebAssembly.validate(artifact.wasm));
} finally {
  compiler.destroy();
}
```

## Wasm boundaries

The checked-in Blot parser binary and plan live under `generated/wasm/`. Layout
first asks Baba's generated Wasm lexer for token boundaries on the original
source. After Blot inserts private layout markers, `src/syntax/parse.ts` runs
the same generated lexer over the elaborated source for authoritative lexical
acceptance. Baba's general-profile `CpuFrontend` then consumes the elaborated
source; its current API accepts source rather than a token tape, so it
internally replays the same lexer tables before executing the island parser.
That replay is an implementation duplication, not a second syntax definition.
The generated-Wasm island parser remains strict-profile-only and is not used for
the general plan.

`src/compiler/hir.ts` runs the development semantic passes and freezes the
Runtime-HIR snapshot. The heavy residual lowering lives under
`src/compiler/lower/`. `src/compiler/backend.ts` is the compiler-owned close and
emission boundary; its ABI and gpupaper implementation lives under
`src/compiler/backend/runtime/`. Conformance code imports these compiler
boundaries, never the other way around.

The residualizer evaluates the staged module result once per exported function
before projecting its named field. This deliberately preserves module-level host
request order and replay behavior shared with the Rust compiler. Settled checked
types drive Store, record, variant, sealed, and host-grant layouts; the value
observed during staging is not allowed to narrow a public layout. Specialized
self-tail recursion becomes a Runtime-HIR loop back-edge, and direct scalar
results cross the canonical Wasm boundary without a return area.

Gpupaper embeds its checked Rust emitter bytes in its published package. Node
instantiates those bytes with the standard `WebAssembly` API, so final emission
does not read a toolchain artifact from disk.

## Target policy and failures

`Compiler.create()` uses an explicit immutable target policy. Today that policy
is ABI major 1 and `wasm-simd128`; making it explicit keeps the implementation
aligned with the `tau` parameter in `spec/COMPILER.md` and prevents hidden
backend defaults from becoming part of the language by accident. Runtime-HIR
schema compatibility is internal to the compiler/backend pair: a mismatch is an
invariant failure, not a caller-selected target.

Source diagnostics, target refusals, and compiler invariant failures are
distinct. An unsupported target policy throws `CompilerTargetRefusal`. A failure
after validated Runtime HIR throws `CompilerInvariantFailure`; it is not
rewritten as a `BLOT_BACKEND_ERROR` source diagnostic with a synthetic
offset-zero span.

## Cache and invalidation

The module loader retains stable AST identity for unchanged source and
invalidates changed modules plus their importers. Checking memoizes a complete
root program by loader identity. A resident check session may independently
recheck a changed dependency and stop before its importers when its conservative
sealed boundary is unchanged; importer-dependent live inference state itself
never crosses that boundary.

A resident compiler also keys each source graph by the exact portable AST,
including spans, dependency revision keys, and included file paths and bytes. An
equal key may reuse the checked summary, Runtime HIR, and finished artifact.
This permits comment-only edits that preserve the portable graph to return
copied bytes marked `revision-cache`, while source-span, dependency, and include
changes invalidate the result. The immutable Runtime-HIR object remains the
final artifact-cache key.

`Compiler.create()` starts Baba runtime and gpupaper emitter initialization in
parallel. Both runtimes are shared for the process lifetime; no semantic fact
crosses a process or unvalidated revision boundary.

## Dual-compiler development

`pnpm parity` discovers every Blot file under `examples/`, `case-studies/`, and
`src/prelude/`, then hosts both compilers in the same Node process. The
development compiler uses Baba, the TypeScript semantic passes, and the
compiler-owned backend. The production compiler is the checked-in Rust compiler
Wasm. Neither path starts Deno, Cargo, or a native Rust process during parity.

For every corpus root, parity compares frontend acceptance, rejection stage and
diagnostic code, Runtime-HIR export phases, canonical ABI manifest bytes, and
capabilities. Internal type pretty-printing and emitted instruction bytes are
not parity observations. `conformance/node-rust-gaps.json` records the current
known gap signatures. The feature-parity baseline is empty. CI runs
`pnpm parity:strict`, so a Node feature, Rust/Wasm feature, diagnostic, export,
manifest, or capability change cannot land while the implementations disagree.
Focused runtime tests cover host-call results, canonical values, conversion edge
rounding, and recursive control flow that manifest comparison cannot observe.

## Benchmark

The combined benchmark hosts both compiler implementations inside one Node
process and first verifies their observable artifacts are comparable:

```bash
pnpm run benchmark -- examples/storage.blot
pnpm run benchmark -- --node-only examples/storage.blot
```

It reports nine-sample medians for initialization, cold and resident builds,
checks, comment-only edits, semantic edits, phase splits, emitted sizes, and
Node-to-Rust ratios. `--node-only` is useful while rebuilding the checked-in
Rust compiler Wasm; it is not a parity measurement.

## CI boundary

Pull-request CI installs exact package versions with pnpm, runs the Node tests
and checker, rebuilds the checked-in Rust compiler Wasm, runs Rust tests, and
requires strict dual-compiler parity. Deno and Cargo exist only in that
artifact-verification job; ordinary `check`, `build`, tests, and benchmark
execution host both checked-in Wasm components in Node. CI also rejects an
uncommitted generated-artifact diff.
