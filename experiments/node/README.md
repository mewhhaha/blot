# Node compilation experiment

This experiment runs a bounded Blot compilation path on Node without installing
Deno or a Rust toolchain.

The pipeline is:

```text
Blot source
  -> Baba CpuFrontend
  -> Blot TypeScript checking/staging
  -> Blot Runtime HIR
  -> gpupaper Core/Wasm plan
  -> gpupaper's checked-in Rust/Wasm emitter
  -> WebAssembly
```

It is deliberately an experiment, not a replacement for the production
compiler. The production path remains the checked-in Rust compiler Wasm and its
existing Baba CPU frontend boundary.

## Setup

Initialize the pinned source dependencies:

```sh
git submodule update --init vendor/baba vendor/gpupaper
```

Node 22 is sufficient; there are no npm dependencies for this experiment.

## Compile

Compile and validate the minimal example without writing output:

```sh
npm run node:compile
```

Compile another source and write the Wasm plus its ABI sidecar:

```sh
npm run node:compile -- examples/minimal.blot --out /tmp/minimal.wasm
```

The Node ESM loader maps the Deno/JSR specifiers used by the existing source to
the pinned submodules. A small compatibility shim supplies only the Deno file
APIs needed by Blot's loader and parser. Baba is mapped to its `CpuFrontend`
directly, so this path never imports or initializes WebGPU.

## Current boundary

The Node experiment intentionally uses Blot's residual Runtime HIR exporter. It
currently accepts the same restricted shape that exporter already accepts:
one default runtime export. It does not broaden the language or change any
compiler, ABI, inference, ownership, or frontend contract.

Package/capsule paths still contain Deno-specific APIs that this first shim does
not emulate. Ordinary source files, relative imports/includes, and
`blot:prelude` use the shimmed file reads.
