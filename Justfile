default: check test

# Regenerate the parser from grammar.baba. The GPU profile must be accepted;
# generation fails loudly if it is not.
generate:
  deno task generate

# Print the version-3 GPU frontend counters. Record changes in
# docs/gpu-profile.md.
inspect:
  deno task inspect

parse file:
  deno task parse {{file}}

# Diagnostic comparison between Baba's CPU and WebGPU general-profile
# executors. Needs an adapter and is not a release gate.
parity:
    WGPU_BACKENDS=vulkan WGPU_POWER_PREF=high \
      deno run --unstable-webgpu --allow-read --allow-env scripts/parity.ts \
      examples/*.blot examples/lib/*.blot case-studies/*/*.blot \
      case-studies/*/lib/*.blot src/prelude/*.blot

# The compiler corpus through the authoritative CPU frontend only.
parity-cpu:
  deno run --allow-read scripts/parity.ts --cpu examples/*.blot examples/lib/*.blot case-studies/*/*.blot case-studies/*/lib/*.blot src/prelude/*.blot

# Parse and evaluate one program.
run file:
  deno run --allow-read src/cli.ts eval {{file}}

# Infer one program's type and check its ownership.
check-file file:
  deno run --allow-read src/cli.ts check {{file}}

# Last-use and linearity facts, for the backend that will consume them.
ownership file:
  deno run --allow-read src/cli.ts ownership {{file}}

# Compile one program through gpupaper's Rust/WebAssembly emitter.
build file:
  deno run --allow-read --allow-write src/cli.ts build {{file}}

# Compile from source to the final artifact in one Rust/WebAssembly instance.
build-experimental file:
  deno run --allow-read --allow-write src/cli.ts build-experimental {{file}}

# Do the interpreter, the GPU evaluator, and the emitted Wasm agree?
wasm:
  WGPU_BACKENDS=vulkan deno run --unstable-webgpu --allow-read --allow-write --allow-env scripts/wasm.ts

# Install the Tree-sitter grammar, queries, and `.blot` association into Helix.
# Re-running replaces the managed block rather than appending a second copy.
install:
  deno run --allow-read --allow-write --allow-env --allow-run=deno,tree-sitter scripts/setup_helix.ts
  just grammar-check
  hx --health blot

# Does the editor grammar agree with the compiler about what blot is? The two
# targets come from one grammar.baba but do not lex alike; this proves they do.
# Needs `just install` to have run.
grammar-check:
  deno run --allow-read --allow-run=tree-sitter scripts/check_grammar.ts

check:
  deno run --allow-read scripts/generate_rust_middle_schema.ts --check
  deno check mod.ts scripts/*.ts case-studies/*.ts experiments/rust-middle/*.ts src/cli.ts src/backend/rust_middle.test.ts syntax.test.ts examples.test.ts inference.test.ts linear.test.ts comptime.test.ts module.test.ts backend.test.ts
  deno fmt --check
  deno lint
  cargo fmt --manifest-path experiments/rust-middle/Cargo.toml --check
  cargo clippy --manifest-path experiments/rust-middle/Cargo.toml --target wasm32-unknown-unknown -- -D warnings
  cargo test --manifest-path experiments/rust-middle/Cargo.toml
  deno task check:rust-middle-artifact
  deno task experiment:rust-middle-parity
  deno task experiment:rust-middle-check-parity
  deno task experiment:rust-middle-eval-parity
  deno task experiment:rust-middle-hir-parity
  deno task verify:rust-compiler

test:
  deno test --allow-read --allow-write

fmt:
  deno fmt
