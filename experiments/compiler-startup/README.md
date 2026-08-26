# Compiler startup decomposition

`pnpm benchmark:compiler-startup` launches a fresh Node process for every sample
and decomposes the direct semantic-core path from artifact reads through a
completed check. It drives `CompilerWasm` directly; the unified compiler
benchmark's cold boundaries measure the public `Compiler` and workspace host.
The default is 31 serial samples; an explicit source must import only
`blot:prelude` so dependency resolution does not hide inside an unlabelled
phase.

```bash
pnpm benchmark:compiler-startup -- examples/minimal.blot --samples=31 \
  --output=experiments/compiler-startup/latest.json
```

Every distribution reports the median, median absolute deviation, p90, and p95.
The `internal` distribution stops exactly at a completed semantic check. The
`process` distribution is an adjusted operational estimate: it subtracts the
measured syntax-consumer-only internal tail from fresh-process wall time. The
`syntaxConsumerProcess` and `syntaxConsumerInternal` distributions include
portable prelude-AST export and decode. The process bootstrap phase is the
adjusted process estimate not accounted for by the child's semantic timer,
including Node startup, module loading, and result transport. It is an
operational boundary rather than compiler work.

Artifact authentication and Wasm compilation begin together because neither
depends on the other's result. Their individual phases therefore overlap;
`artifact-authenticate-and-compile` records their combined elapsed boundary.
Compilation is requested before Node's synchronous native SHA-256 digest so the
engine may compile on its worker while the main thread authenticates the exact
artifact bytes. Instantiation begins only after both have completed
successfully.

Prelude AST export and decode run after the semantic boundary and are also
reported as individual phases because syntax consumers may request them.
Ordinary semantic compilation leaves that host AST unmaterialized and therefore
does not pay either phase.

Provenance is collected before the first sample and again after the final
sample, outside every measured boundary; the report is rejected if the captures
differ. It records the exact startup-harness and host-input digests, stable
source path and path-independent source-graph identity, compiler artifact and
manifest digests, manifest compiler/prelude/source identities, compiler build
toolchain, repository commit, Node/V8 versions, platform, architecture, CPU
models/count, and a path-stable digest of Node flags and `NODE_OPTIONS`. The
source-graph identity covers the root source and the validated prelude snapshot
installed by the measured path. Host inputs include relevant untracked files; a
tracked deletion is represented as a missing-file marker instead of making the
benchmark fail after sampling. The ignored generated `.pnp.cjs` loader is
required and hashed because Node executes it on this benchmark path.

The schema decoder rejects missing provenance, malformed or inconsistent timing
boundaries, incomplete phase matrices, and summary distributions that do not
match their raw samples. Compare reports only when sample count, harness,
runtime, stable path, source graph, and every identity outside the optimization
under test agree.

An optimization is retained only when three independent 31-sample runs show at
least a 10% median improvement at its target boundary, no important boundary
regresses by more than 5%, deterministic work does not increase without an
explained tradeoff, shipped payload growth is justified, and the full semantic
verification suite passes.
