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

Closing is the semantic revision boundary. If an edit produces the same AST,
including source spans, the session keeps its compile-time result, inferred
interface, ownership and safety certificates, `ClosedProgram`, and final
artifact. A changed AST, resolved import, or included file invalidates all of
those for the module and its transitive importers. `prepare` and `compile`
consequently share one cached `ClosedProgram` instead of staging or planning the
module twice.

## Release gates

The compiler is checked at each observable boundary:

- its generated schema and embedded frontend plan must match `parser.plan`;
- Cargo formatting, clippy with warnings denied, and Rust tests pass;
- a release rebuild must match the checked-in compiler Wasm byte for byte;
- 129 accepted corpus modules have exact Rust/TypeScript AST parity;
- syntax and semantic rejections agree on acceptance and diagnostic codes;
- 54 runnable examples have equal evaluator results;
- 54 repository programs have equal staged phases and ABI manifests, while the
  same eight programs are rejected by both implementations;
- all 61 examples compile to valid Wasm with byte-identical ABI manifests;
- 271 decoded runtime exports and their host-effect observations agree with the
  independent language oracle across 56 programs;
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
