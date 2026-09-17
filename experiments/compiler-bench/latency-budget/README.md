# Full-compilation latency budget

This draft continues from PR #171 at `92972a5` without modifying its validated
source. The target is 100 ms for a genuinely compiled application, not a cache
hit relabeled as compilation. No result at that target is currently established.

Measure three different operations explicitly:

- Cold: the first complete compilation in a fresh process and compiler session.
- Edited: compilation after a source change, including invalidation and
  checking.
- Unchanged: a revision-cache hit, reported separately as a control.

Compiler loading and initialization, source checking, runtime preparation, final
emission, and process wall time must remain visible. A change that merely moves
work outside the measured interval is not a compiler speedup.

The current experiment replaces repeatedly copied effect-call histories with a
persistent immutable provenance graph. Node-local hashes select lookup buckets;
exact equality, revision searches, and teardown traverse graph nodes rather than
expanding shared paths. Source revisions, ordering, effect identity, and
serialized scope contents remain unchanged. See `spec/STAGING.md` for the
identity contract and `spec/COMPILER.md` for the measurement boundary.

The first experiment and all twelve cold/edit/control observations are recorded
in [PROVENANCE_RESULTS.md](PROVENANCE_RESULTS.md). It establishes deterministic
graph-work bounds, but no reliable further application speedup.

## Reproduction

Build a normal production compiler using `scripts/build_compiler.ts --check`.
The generic harness accepts a local entry point and a separate replacement
entry-buffer file. It never embeds an application:

```sh
deno run -A experiments/compiler-bench/compile-sample.ts \
  --entry=/absolute/project/src/main.blot \
  --mode=edited --edit=/absolute/edited-main.blot \
  --wasm=/absolute/distribution/compiler.wasm \
  --snapshot=/absolute/distribution/prelude.snapshot
```

Every invocation first performs a cold compilation. The edited interval starts
before applying the overlay and includes invalidation and complete emission. The
unchanged control runs against that edited revision afterward. The harness
rejects identical replacement source, unexpected artifact-cache hits, invalid
Wasm, and an unchanged control which does not preserve exact artifact bytes. It
reports whether the changed source also changed executable bytes. Use a semantic
edit with `wasmChanged: true` for a changed-program latency claim. Keep the
entry and its dependencies immutable on disk throughout each sample; the edit is
applied only in the compiler session. Input and edit hashes are reported without
source paths or contents.

Use fresh processes and alternate artifact order for paired measurements. Keep
profiles, builds, and tests out of the timing batch; retain every sample and
disclose timeouts. Initialization, production compiler/input hashes, cold
compilation, edited compilation, unchanged hits, and process wall time must all
be recorded. Reading the editor-supplied replacement buffer and validating or
hashing outputs are not part of the edited interval. An entry-only edit does not
establish performance for changes to imports or public interfaces.

The application snapshot remains private. Do not publish application source,
Wasm, ABI contents, or source-bearing profiles in this public repository.
Synthetic regressions and aggregate measurements belong here.
