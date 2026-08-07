# Rust/WebAssembly Compiler

Blot compiles source text to caller-facing WebAssembly inside one Rust-built
WebAssembly instance:

```text
source bundle -> embedded Baba DFA/island plan -> compact CST -> fixity -> AST
              -> comptime -> biunification -> ownership -> staging
              -> Runtime HIR -> ABI 1/layout planning -> WebAssembly bytes
```

Baba remains the grammar and parser-plan generator. `deno task generate` creates
the authoritative binary parser plan, and `generate:rust-middle-schema`
translates its lexer and island tables into checked-in typed Rust slices. The
shipped compiler executes those tables directly: it does not parse JSON, load
Baba at runtime, or implement a second grammar.

The compiler also owns its final backend. One `PublicLayout` builds the ABI 1
manifest, canonical layouts, host imports, allocator shell, post-return
protocol, and `blot:abi` custom section. One Runtime-HIR emitter uses the pinned
`wasm-encoder` crate to encode the standardized binary format. No compiler
command initializes WebGPU.

The checked-in compiler distribution consists of
[`generated/rust-middle/compiler.wasm`](../generated/rust-middle/compiler.wasm)
and
[`generated/rust-middle/prelude.snapshot`](../generated/rust-middle/prelude.snapshot).
Cargo is needed to rebuild or verify them, not to compile a Blot program.

## Use it

```bash
deno task blot build examples/storage.blot
just build examples/storage.blot
```

Library consumers create a `Compiler` from the package root. The TypeScript host
performs filesystem reads, path and package resolution, and module-capsule hash
and graph validation. It passes source or a validated portable AST to the
resident Rust session, which owns compiler state. Each source module retains its
UTF-16 text and dependency-aware token stream; an edit reuses the unaffected
token prefix and runs the lexer from the first token whose decision observed the
edited position. Island parsing and CST materialisation then run over the
resulting complete token stream.

`checkSource(path, source)` installs an in-memory revision for the named root
while resolving imports and includes normally. This is the language-server entry
point: unsaved text passes through the same frontend, checker, and revision
invalidation as `check(path)` without writing an editor buffer to disk.

Closing is the semantic revision boundary. If an edit produces the same AST,
including source spans, the session keeps its compile-time result, inferred
interface, ownership and safety certificates, `ClosedProgram`, and final
artifact. A changed AST, resolved import, or included file invalidates all of
those for the module and its transitive importers. Within a changed module, an
exactly unchanged top-level declaration prefix keeps its successful
deterministic values while the checker still infers every declaration in the new
revision. A changed preceding declaration or dependency mapping discards the
suffix. `prepare` and `compile` consequently share one cached `ClosedProgram`
instead of staging or planning the module twice.

Checked-module certificate schema 3 records the closure bodies in recursive
components of each typed `rec` group. Runtime-HIR preparation may introduce a
private indirect root only for one of those bodies; an unresolved result is no
longer sufficient authorization by itself.

## Release gates

The compiler is checked at each observable boundary:

- its generated schema and embedded frontend plan must match `parser.plan`;
- Cargo formatting, clippy with warnings denied, and Rust tests pass;
- a release rebuild must match the checked-in compiler Wasm byte for byte;
- 164 corpus modules have Rust/TypeScript AST parity, including 23 rejected by
  both frontends;
- syntax and semantic rejections agree on acceptance and diagnostic codes;
- 55 runnable examples have equal evaluator results;
- 63 repository roots have equal Runtime HIR and ABI manifests where both
  authorities admit them, with six mutual and two bounded-oracle rejections
  named explicitly;
- all 62 examples compile to valid Wasm with byte-identical ABI manifests;
- 279 decoded runtime exports and their host-effect observations agree with the
  independent language oracle across 62 programs;
- the five programs outside the bounded TypeScript oracle are named explicitly
  by the differential gate and still compile and execute through the production
  compiler;
- the terminal application residualizes a text-returning host effect, agrees on
  both control-flow branches and non-ASCII text, and traps malformed UTF-8 at
  the canonical ABI boundary;
- structural host effects preserve canonical field order, validate text nested
  in returned records, and use trapping signed-integer arithmetic.

Run the source-to-Wasm differential gate directly with:

```bash
deno task verify:rust-compiler
```

Rebuild and verify the checked-in artifact with:

```bash
deno task build:rust-middle
deno task check:rust-middle-artifact
```

## Fair comparison

`experiment:rust-middle` measures the complete compiler boundary on both sides.
The TypeScript measurement includes source loading through gpupaper emission;
the Rust measurement includes source loading through the single-Wasm emitter. It
compares exact ABI bytes before reporting timings.

On `examples/storage.blot`, the median of five independent nine-sample runs on
2026-08-04 measured. The compiler artifact was
`2698d91c1fa28920039f63b18f50fd22cefd81dd8779afb8190665584445f165`.

| boundary                              | TypeScript/gpupaper | Full Rust/Wasm |
| ------------------------------------- | ------------------: | -------------: |
| cold end to end                       |            164.4 ms |        73.6 ms |
| Rust Wasm instantiation               |                   — |         3.4 ms |
| unchanged resident compilation        |             2.60 ms |       0.105 ms |
| source-only edit, same lowered module |             31.5 ms |       0.781 ms |
| changed lowered module                |             29.7 ms |        14.4 ms |
| emitted Wasm                          |        13,218 bytes |   13,212 bytes |

The cold full-Rust path was about 2.2 times faster, its unchanged revision cache
about 24.7 times faster, a source-only edit about 40.3 times faster, and a
changed module about 2.1 times faster in those runs. Both incremental cases copy
the complete measured source beside the original. The source-only case changes a
trailing comment and measures incremental lexing plus semantic cache retention.
The changed-module case inserts a revision binding and therefore exercises
lowering, invalidation, checking, staging, and emission.

The original 682.9 ms Rust result was dominated by cloning the complete
inference-variable graph before every speculative ground-union constraint.
Journalled rollback reduced the same cold boundary to about 95--107 ms after
instantiation while preserving diagnostic, HIR, evaluation, and ABI parity. The
transaction invariant and the rest of the type-checking model are specified in
[`spec/TYPECHECKING.md`](../spec/TYPECHECKING.md). The compiler-wide cost terms
and benchmark classes are defined in
[`spec/COST_MODEL.md`](../spec/COST_MODEL.md).

The unchanged resident checker measured 0.280 ms. A changed module spent 13.0 ms
in frontend loading and checking, 1.30 ms preparing HIR, and 0.344 ms emitting
after preparation. Island recursion uses one flat active-path stack, and opened
compile-time records retain shared immutable field tables instead of cloning
their recursive values into the importing environment. The checker retains
safely encodable expanded interfaces for unaffected dependencies in addition to
their flat transport form. It reuses completed compile-time environments and
nullary ownership/safety certificates; reverse-import invalidation discards them
when their source graph changes. Mutable constraint edges are `u32` IDs into a
flat append-only arena, while semantic equality still recognizes row permutation
and quantified alpha-equivalence. The phase split does not identify a dominant
finite-row scan, so explicit SIMD row operations are not justified by this
profile. These are observations, not release constants; rerun the benchmark on
the machine and source being evaluated.

On 2026-08-05, five independent nine-sample runs compared checkpoint `aca0a0d`
with the declaration-prefix evaluation cache on the same machine. The table
reports the median of the five run medians. The checkpoint compiler hash was
`6a7ed4183061b669aa5bcaa9e27254edc55fadd28f67279797f73490060e5d58`; the new
compiler hash was
`6c823c3479cd07e60a4da76a9bb5fea18e578b058847182942a51b0875c984c4`.

| `examples/storage.blot` boundary |      Checkpoint |    Prefix cache |    Change |
| -------------------------------- | --------------: | --------------: | --------: |
| changed module                   |         9.04 ms |         4.96 ms |      -45% |
| checking within changed module   |         6.74 ms |         4.14 ms |      -39% |
| prepare after check              |         1.43 ms |         1.37 ms |       -4% |
| emit after prepare               |        0.316 ms |        0.314 ms | unchanged |
| unchanged resident compilation   |       0.0597 ms |       0.0538 ms | unchanged |
| source-only edit                 |         1.30 ms |         1.35 ms | unchanged |
| compiler plus prelude snapshot   | 2,407,040 bytes | 2,425,435 bytes |     +0.8% |
| emitted program                  |    14,830 bytes |    14,830 bytes | unchanged |

Cold compilation after instantiation measured 61.11 ms at the checkpoint and
51.90 ms with the cache, but declaration-prefix reuse cannot accelerate a fresh
session; that movement is reported as run noise rather than attributed to this
change. The measured incremental reduction comes from retaining successful
deterministic values for the exact unchanged top-level prefix while inference,
ownership, and safety still derive the edited revision.

On 2026-08-07, a nine-sample run after the affine-arena change measured the
current `examples/storage.blot` boundary with compiler hash
`cbb538b9edfce8e8fdf20937fd31a389a151587c64016e941e0a1be54c778fdc`:

| boundary                       | Full Rust/Wasm |
| ------------------------------ | -------------: |
| cold after instantiation       |        62.2 ms |
| Wasm instantiation             |         6.1 ms |
| unchanged resident compilation |       0.061 ms |
| source-only edit               |        1.17 ms |
| changed module                 |        5.86 ms |
| check within changed module    |        4.24 ms |
| prepare after check            |        1.59 ms |
| emit after prepare             |       0.277 ms |

The Store-reuse marker and allocator fast path did not move compiler throughput
outside the earlier run-to-run range. The changed-module profile is still
dominated by checking and Runtime-HIR preparation; emission is not the next
compiler-speed target.

A 2026-08-07 profile after recursive Runtime HIR and path-sensitive ownership
used compiler hash
`2cb2071fd52da08068846c071052ca366ba1475fcf7aa829751926b2b83f3186`. Each row is
one nine-sample median. The benchmark's changed-module edit inserts a dead
revision binding: it changes the lowered module and invalidates the revision,
but deliberately does not change the observation. It therefore measures the
current invalidation and re-derivation boundary, not a general semantic-edit
distribution.

| source                     | changed module |   check | prepare after check | emit after prepare |
| -------------------------- | -------------: | ------: | ------------------: | -----------------: |
| `examples/minimal.blot`    |        2.21 ms | 1.79 ms |            0.142 ms |           0.103 ms |
| `examples/storage.blot`    |        7.11 ms | 5.10 ms |             1.70 ms |           0.314 ms |
| `examples/arena_list.blot` |        23.6 ms | 6.60 ms |             14.4 ms |           0.293 ms |

The list-heavy source emits only 63 Runtime-HIR operations, so its 14.4 ms
preparation time is not proportional to final HIR size. It is dominated by
re-running staged recursive evaluation and reconstructing the residual trace.
The evidence therefore supports the existing architectural next step:
progressively commit settled Runtime HIR while checking and retain it across
irrelevant edits. Emission remains roughly three tenths of a millisecond even
for the two larger programs and is not an optimization target.

## Package capsule comparison

`experiment:package` compares an npm-linked package containing the 45,191-byte
prelude as ordinary source with the same package containing only its 75,602-byte
source-free `.blotc` capsule. Each cold sample runs in a fresh Deno process,
source and capsule order alternates, and package construction happens outside
the clock. The resident values are medians of five independent runs with nine
samples per run. Both forms must infer the same type and effects, emit the same
normalized ABI, and execute `blot:by_accessor` to `10` before timings are
reported.

On `examples/storage.blot`, nine cold samples on 2026-08-04 measured:

| boundary                    | source package | `.blotc` package | capsule change |
| --------------------------- | -------------: | ---------------: | -------------: |
| TypeScript load             |        68.9 ms |          39.6 ms |       -29.3 ms |
| TypeScript check            |       142.7 ms |         105.9 ms |       -36.9 ms |
| TypeScript compile          |       170.8 ms |         133.8 ms |       -36.9 ms |
| TypeScript resident compile |        2.47 ms |          2.36 ms |       -0.12 ms |
| full-Rust check             |        72.2 ms |          94.9 ms |       +22.7 ms |
| full-Rust compile           |        76.4 ms |          99.7 ms |       +23.2 ms |
| full-Rust resident compile  |       0.173 ms |         0.163 ms |      -0.009 ms |

The source-free capsule removes package frontend work. That reduced the default
TypeScript/gpupaper compilation boundary by 22% in this run and made its load
boundary 43% faster. It left TypeScript resident compilation effectively
unchanged and made the full-Rust resident boundary slightly faster. The cold
full-Rust compiler remains faster at parsing the 45 KB source with its compact
embedded Baba tables than decoding and transporting the portable AST; its
capsule boundary regressed by 30%. Closing that separate gap requires a direct
binary-AST guest boundary rather than weakening capsule validation or restoring
source. A later checked-interface certificate could additionally remove the
checking terms described in [`spec/COST_MODEL.md`](../spec/COST_MODEL.md).

Reproduce this comparison with:

```bash
deno task experiment:package
```

## Prebuilt prelude module

The full-Rust compiler ships a separate 167,569-byte MessagePack snapshot
containing the prelude's validated portable AST and closed checked interface.
The ordinary module loader resolves the explicit `@import "blot:prelude"` to
that artifact; the prelude receives no implicit scope or type-system privilege.
The build task regenerates the snapshot with the ordinary Rust frontend and
checker, and check mode rejects stale snapshot or compiler bytes. The decoder
validates both flat arenas, then evaluates the prelude once to construct
compile-time closures. Registry capsules cannot install this
distribution-trusted interface.

Separating the snapshot reduced `compiler.wasm` from 2,396,580 to 2,240,359
bytes. The compiler and 167,569-byte snapshot total 2,407,928 bytes; the
distribution is 11,348 bytes larger because the snapshot no longer shares the
Wasm artifact's binary layout.

Five independent nine-sample warmed-engine runs on 2026-08-04 compiled
`examples/storage.blot` in an 18.18 ms median after compiler-Wasm instantiation.
Instantiation took 3.79 ms and the complete boundary took 22.59 ms. The earlier
compiler-embedded representation measured 20.20 ms at the complete boundary,
while loading the prelude as ordinary source measured 51.33 ms. These are
same-process fresh-session measurements; fresh-process timings remain higher
because they include engine and runtime cold state.
