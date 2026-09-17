# Complete compilation investigation

This draft investigates full executable compilation, rather than substituting
semantic analysis or an unchanged artifact-cache hit for compilation. The user
workload remains private. No application source, Wasm, ABI contents, or
source-bearing diagnostic stacks are published here. The benchmark accepts a
locally available entry point.

## Reproduce the measurement boundary

After building the normal compiler distribution, run from the repository root:

```sh
timeout 90 deno run --allow-read --allow-env experiments/compiler-bench/compile-sample.ts --entry=/absolute/path/main.blot
timeout 90 deno run --allow-read --allow-env experiments/compiler-bench/compile-sample.ts --entry=/absolute/path/main.blot --mode=split
timeout 90 deno run --allow-read --allow-env experiments/compiler-bench/compile-sample.ts --entry=/absolute/path/main.blot --mode=resident
```

The same harness also runs under Node:

```sh
node --import tsx experiments/compiler-bench/compile-sample.ts --entry=/absolute/path/main.blot
```

Do not combine Node and Deno observations: they use different engine versions
and runtime configurations. Each invocation is a separate process. `cold` is the
default and includes final Wasm emission. Compiler initialization is separate.
`split` prepares runtime HIR first and labels both intervals. `resident` also
measures an unchanged-source artifact hit; it is **not an edited rebuild**.

Use a parent-enforced timeout to bound synchronous Wasm stalls. Do not run
builds, tests, other samples, or profilers concurrently with latency
measurements. Alternate baseline/candidate order and retain every observation.

Supply both `--wasm=/absolute/path/compiler.wasm` and
`--snapshot=/absolute/path/prelude.snapshot` for an explicitly paired compiler
and prelude snapshot. Build both artifacts with the same Rust version and normal
`scripts/build_compiler.ts` production profile. Diagnostic profiles must not be
silently compared with distribution profiles.

The JSON observation reports output and input hashes without publishing source
paths or contents. Input hashing, output validation, and optional output writing
happen **after** the compilation timer. The input digest includes the observed
closure's absolute paths, so compare it within the same checkout, not across
relocated workspaces. It is not an atomic filesystem snapshot: all sources must
stay unchanged throughout the sample. `--output=/local/prefix` writes the Wasm
and ABI for private inspection and additionally requires write permission.

## This increment

`closure_free_names` used to rescan an immutable closure body whenever capture
planning, residual identity, signature checking, or environment replacement
asked for it. It now shares a sorted syntax result on the loaded module, keyed
by the parameter, body, and recursive binder. Replacing or releasing that AST
releases its cache. This does not cache captured values, attached signatures,
type substitutions, or effect substitutions; those remain current-instance
evidence.

`begin_residual_function` now rejects an optional residualization attempt before
capture planning when an already selected signature necessarily requires
ordinary staging. A signature requiring instance-specific checking cannot take
that shortcut. The final, possibly rechecked signature still goes through the
same eligibility policy. Checked capture types are constructed only when the
instance checker will consume them.

Residual-function lookup also rejects incompatible source bodies and call
representations before comparing potentially large environment keys. Every
successful match still requires the same exact environment and signature
equality. No pointer or digest replaces semantic evidence.

The seven focused native regressions cover syntax reuse, every cache-key
component, AST replacement and release, changing capture values/signatures and
substitutions, skipped capture traversal, and the recursive/host-callback
staging boundaries. Existing abstraction, ownership, effect, and
cache-invalidation suites remain required.

## Earlier exploration and remaining work

Initial stacks identified transitive capture identity construction on the slow
path. The first investigation note proposed graph-preserving type/signature
chunks. That separate experiment is **not part of this increment**: this change
avoids unnecessary traversals and syntax recomputation first. Residual evidence
still has opportunities for graph-aware construction and comparison.

The target remains millisecond compilation of an actual changed program. A
reduced synthetic test, a warm artifact-cache hit, or faster semantic analysis
alone does not meet that target. See [RESULTS.md](RESULTS.md) for the complete
paired observations and their limitations.
