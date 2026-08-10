# Node-hosted Wasm compiler

This experimental branch compiles Blot with Node as the only host:

```text
source
  -> Baba generated Wasm lexer
  -> Baba general-profile CPU island parser
  -> Blot TypeScript semantics
  -> validated Runtime HIR
  -> gpupaper Core
  -> gpupaper embedded Rust/Wasm emitter
  -> WebAssembly + ABI manifest
```

Baba owns lexing and parsing. Blot checks, evaluates the compile-time fragment,
proves ownership, stages the program, and exports Runtime HIR. Gpupaper owns
Core-to-Wasm planning and final binary emission. Ordinary compilation uses no
Deno runtime, native Rust toolchain, Cargo process, WebGPU device, or handwritten
parser.

## Versions

| Component | Version |
| --- | ---: |
| Node | 24.14.0 or newer |
| pnpm | 11.21.0 |
| Baba | 9.0.0 |
| gpupaper | 0.1.6 |
| @std/path | 1.1.6 |

The pnpm workspace applies a seven-day minimum release age and excludes the two
`@mewhhaha` packages, whose coordinated releases may need immediate testing.

## Use it

```bash
corepack enable
pnpm install
pnpm blot check examples/minimal.blot
pnpm blot build examples/minimal.blot
pnpm test
```

`build` writes `examples/minimal.wasm` and
`examples/minimal.wasm.json`. The sidecar bytes match the `blot:abi` custom
section embedded in the module.

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

The checked-in Blot parser binary and plan live under `generated/wasm/`.
`src/syntax/layout.ts` and `src/syntax/parse.ts` instantiate the binary with
Baba's generated-Wasm runtime for authoritative lexing. Blot's plan declares
`general` throughput, while Baba's generated-Wasm island parser accepts only
`strict`; `src/syntax/parse.ts` therefore hands the same source and plan to
Baba's own `CpuFrontend` for island parsing and materializes its compact CST.
This bridge duplicates lexing but does not duplicate Baba's lexer or parser
logic.

`src/compiler/node_hir.ts` runs the authoritative Blot semantic passes and
freezes the Runtime-HIR snapshot. `src/conformance/gpufuck/runtime/target.ts`
lowers that snapshot to gpupaper Core and emits through a resident
`createRustWasmEmitter` instance. Despite the legacy directory name, this path
imports no gpufuck runtime.

Gpupaper embeds its checked Rust emitter bytes in its published package. Node
instantiates those bytes with the standard `WebAssembly` API, so final emission
does not read a toolchain artifact from disk.

## Cache and invalidation

The module loader retains stable AST identity for unchanged source and
invalidates changed modules plus their importers. Checking memoizes a complete
root program by loader identity; dependency checks are not cached independently,
because their facts can depend on importer constraints and staging context.

A resident compiler also keys each source graph by the exact portable AST,
including spans, dependency revision keys, and included file paths and bytes.
An equal key may reuse the checked summary, Runtime HIR, and finished artifact.
This permits comment-only edits that preserve the portable graph to return copied
bytes marked `revision-cache`, while source-span, dependency, and include changes
invalidate the result. The immutable Runtime-HIR object remains the final
artifact-cache key.

`Compiler.create()` starts Baba runtime and gpupaper emitter initialization in
parallel. Both runtimes are shared for the process lifetime; no semantic fact crosses a
process or unvalidated revision boundary.

## CI boundary

Pull-request CI installs exact package versions with pnpm and runs the Node test
and checker. It intentionally installs neither Deno nor Rust. The smoke test
compiles `examples/minimal.blot` and validates the emitted WebAssembly.
