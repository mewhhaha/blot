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

# Refuse accepted Blot source with correctness or readability findings.
lint-check file:
  deno run --allow-read src/cli.ts lint --check {{file}}

# Apply compiler-validated lint fixes, then refuse any remaining findings.
lint-fix file:
  deno run --allow-read --allow-write src/cli.ts lint --fix {{file}}

# Last-use and linearity facts, for the backend that will consume them.
ownership file:
  deno run --allow-read src/cli.ts ownership {{file}}

# Compile one program by hosting the Rust/Wasm compiler.
build file:
  deno run --allow-read --allow-write src/cli.ts build {{file}}

# Do the Rust evaluator and emitted Wasm agree on the conformance corpus?
conformance:
  pnpm conformance

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
  deno check --config deno.desktop.json --desktop case-studies/engine/desktop.ts
  deno fmt --check
  deno fmt --config deno.desktop.json --check case-studies/engine/desktop.ts
  deno lint
  deno lint --config deno.desktop.json case-studies/engine/desktop.ts
  pnpm run docs:check
  pnpm run current:check
  deno task check:generated
  rustfmt --edition 2024 --check experiments/generated-code/counterpart.rs
  cargo fmt --manifest-path compiler/Cargo.toml --check
  cargo clippy --manifest-path compiler/Cargo.toml --target wasm32-unknown-unknown -- -D warnings
  cargo test --manifest-path compiler/Cargo.toml
  deno run --allow-read --allow-write --allow-run=cargo,git,rustc --allow-env scripts/build_compiler.ts --check
  pnpm run check
  pnpm run smoke
  pnpm conformance

test:
  pnpm test

# Check the intrinsically typed stable-Core metatheory.
formal:
  cd formal/lean && lake build

# Exercise the built Rust/Wasm compiler across its frontend, checker,
# evaluator, and Runtime-HIR integration boundaries.
compiler-integration:
  pnpm test:compiler

# Compare every executable example through the oracle and emitted Wasm.
verify-compiler:
  pnpm verify:compiler

fmt:
  deno fmt
