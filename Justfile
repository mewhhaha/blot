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

# Byte parity between baba's CPU oracle and the WebGPU frontend. Needs an
# adapter; nothing else in the repository does.
parity:
  WGPU_BACKENDS=vulkan WGPU_POWER_PREF=high \
    deno run --unstable-webgpu --allow-read --allow-env scripts/parity.ts \
      examples/*.blot examples/lib/*.blot src/prelude/*.blot

# The same corpus through the CPU oracle only.
parity-cpu:
  deno run --allow-read scripts/parity.ts --cpu examples/*.blot examples/lib/*.blot src/prelude/*.blot

# Parse and evaluate one program.
run file:
  deno run --allow-read src/cli.ts eval {{file}}

# Infer one program's type and check its ownership.
check-file file:
  deno run --allow-read src/cli.ts check {{file}}

# Last-use and linearity facts, for the backend that will consume them.
ownership file:
  deno run --allow-read src/cli.ts ownership {{file}}

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
  deno check scripts/*.ts src/cli.ts syntax.test.ts examples.test.ts inference.test.ts linear.test.ts
  deno fmt --check
  deno lint

test:
  deno test --allow-read --allow-write

fmt:
  deno fmt
