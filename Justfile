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

# Run the editor language server over standard input/output.
lsp:
  deno run --allow-read src/cli.ts lsp

# Format one Blot source file with the source formatter.
format file:
  deno run --allow-read --allow-write src/cli.ts fmt {{file}}

# Refuse a Blot source file that is not formatted.
format-check file:
  deno run --allow-read src/cli.ts fmt --check {{file}}

# Last-use and linearity facts, for the backend that will consume them.
ownership file:
  deno run --allow-read src/cli.ts ownership {{file}}

# Compile one program through the Node development compiler.
build file:
  deno run --allow-read --allow-write src/cli.ts build {{file}}

# Do the interpreter, the GPU evaluator, and the emitted Wasm agree?
wasm:
  WGPU_BACKENDS=vulkan deno run --unstable-webgpu --allow-read --allow-write --allow-env scripts/wasm.ts

# Install the Tree-sitter grammar, queries, LSP, and `.blot` association into Helix.
# Re-running replaces that block rather than appending a second copy.
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
  deno check .
  deno fmt --check
  deno lint
  rustfmt --edition 2024 --check experiments/generated-code/counterpart.rs
  cargo fmt --manifest-path compiler/Cargo.toml --check
  cargo clippy --manifest-path compiler/Cargo.toml --target wasm32-unknown-unknown -- -D warnings
  cargo test --manifest-path compiler/Cargo.toml
  deno run --allow-read --allow-write --allow-run=cargo --allow-env scripts/build_compiler.ts --check
  pnpm run check
  pnpm run smoke
  pnpm parity:strict

test:
  pnpm test

fmt:
  deno fmt
