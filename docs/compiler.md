# Node-hosted Wasm compiler

This experimental branch compiles Blot with Node as the only host:

```text
source
  -> Baba generated parser Wasm
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
`src/syntax/parse.ts` instantiates them with Baba's generated-Wasm runtime and
adapts Baba cursors only to restore original source offsets after layout
elaboration.

`src/compiler/node_hir.ts` runs the authoritative Blot semantic passes and
freezes the Runtime-HIR snapshot. `src/conformance/gpufuck/runtime/target.ts`
lowers that snapshot to gpupaper Core and calls
`emitWasmPlanOnRustWasm`. Despite the legacy directory name, this path imports
no gpufuck runtime.

Gpupaper embeds its checked Rust emitter bytes in its published package. Node
instantiates those bytes with the standard `WebAssembly` API, so final emission
does not read a toolchain artifact from disk.

## Cache and invalidation

The module loader retains stable AST identity for unchanged source and
invalidates changed modules plus their importers. A compiler session caches a
finished artifact by the immutable Runtime-HIR object. Recompiling an unchanged
revision returns copied bytes marked `revision-cache`.

## CI boundary

Pull-request CI installs exact package versions with pnpm and runs the Node test
and checker. It intentionally installs neither Deno nor Rust. The smoke test
compiles `examples/minimal.blot` and validates the emitted WebAssembly.
