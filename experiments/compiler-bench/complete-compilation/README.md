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

## First increment: syntax and capture demand

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

## Second increment: traversal-local shared evidence

Residual keys now retain immutable function/range edges and attached signature
roots as shared structural chunks within one builder traversal. Owners stay
alive until the traversal ends. New closure definitions are not reusable chunks;
only reference-stable evidence is shared. Independent allocations still compare
by structure, and portable encoding sees the same flattened evidence sequence.

Inherited type/effect substitutions are materialized once for a demanded frame
and shared with its unchanged empty-frame descendants. A nearer binding still
shadows its ancestor. A deep path with a binding at every frame must not retain
a complete map at every prefix: one request constructs one combined map. None of
these snapshots survives into a later key construction, so later environment,
parent, signature, and substitution changes remain observable.

Eight focused native tests cover type-DAG growth, repeated signature ownership,
copy-on-write mutation, empty ancestry, a 1,024-frame nonempty substitution
chain, nearest shadowing and subsequent mutations, first closure definitions,
and exact flattened portable identity. Existing capture, revision, effect,
ownership, and abstraction suites remain required.

See [SHARING_RESULTS.md](SHARING_RESULTS.md) for the three-artifact comparison
of main, the first published increment, and the graph-sharing increment. Its
observations are a separate batch from [RESULTS.md](RESULTS.md); the report does
not multiply percentages from different batches.

## Remaining work

The target remains millisecond compilation of an actual changed program. A
reduced synthetic test, a warm artifact-cache hit, or faster semantic analysis
alone does not meet that target. Identity construction still examines transitive
closure captures, and the syntax cache does not eliminate their changing value
and substitution evidence. Source checking and later runtime preparation remain
separate costs.
