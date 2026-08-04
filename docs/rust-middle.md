# Full Rust/WebAssembly Compiler

Blot has an opt-in compiler that runs from source text to caller-facing
WebAssembly inside one Rust-built WebAssembly instance:

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

The alternative also owns its final backend. It builds the same ABI 1 manifest,
canonical constant layouts, host imports, allocator shell, post-return protocol,
and `blot:abi` custom section as the TypeScript/gpupaper path. It uses the
pinned `wasm-encoder` crate to encode the standardized binary format. No
compiler command initializes WebGPU.

The checked-in
[`generated/rust-middle/compiler.wasm`](../generated/rust-middle/compiler.wasm)
is the only runtime artifact. Cargo is needed to rebuild or verify it, not to
compile a Blot program.

## Use it

```bash
deno task blot build-experimental examples/storage.blot
just build-experimental examples/storage.blot
```

`build-experimental` writes the same `.wasm` and `.wasm.json` outputs as
`build`. Library consumers can create an `ExperimentalCompiler` from the package
root. The TypeScript host performs filesystem reads and path resolution only. A
resident Rust session owns parsing and compiler state. Each source module
retains its UTF-16 text and dependency-aware token stream; an edit reuses the
unaffected token prefix and runs the lexer from the first token whose decision
observed the edited position. Island parsing and CST materialisation then run
over the resulting complete token stream.

Lowering is the semantic revision boundary. If an edit produces the same AST,
including source spans, the session keeps its compile-time result, inferred
interface, ownership and safety certificates, Runtime HIR, and final artifact. A
changed AST, resolved import, or included file invalidates all of those for the
module and its transitive importers. `prepare` and `compile` consequently share
one cached Runtime HIR instead of staging the module twice.

## Production gates

The alternative compiler is checked at each observable boundary:

- its generated schema and embedded frontend plan must match `parser.plan`;
- Cargo formatting, clippy with warnings denied, and Rust tests pass;
- a release rebuild must match the checked-in compiler Wasm byte for byte;
- 129 accepted corpus modules have exact Rust/TypeScript AST parity;
- syntax and semantic rejections agree on acceptance and diagnostic codes;
- 54 runnable examples have equal evaluator results;
- 54 repository programs have equal staged phases and ABI manifests, while the
  same eight programs are rejected by both implementations;
- all 61 examples compile to valid Wasm with byte-identical ABI manifests;
- 330 decoded runtime exports and their host-effect observations agree with the
  independent language oracle;
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

On `examples/storage.blot`, a nine-sample run on 2026-08-04 measured:

| boundary                              | TypeScript/gpupaper | Full Rust/Wasm |
| ------------------------------------- | ------------------: | -------------: |
| cold end to end                       |            189.3 ms |        95.9 ms |
| Rust Wasm instantiation               |                   — |         3.7 ms |
| unchanged resident compilation        |             4.12 ms |       0.128 ms |
| source-only edit, same lowered module |             39.7 ms |        1.30 ms |
| changed lowered module                |             39.6 ms |        17.4 ms |
| emitted Wasm                          |        13,218 bytes |   13,212 bytes |

The cold full-Rust path was about 2.0 times faster, its unchanged revision cache
about 32.2 times faster, a source-only edit about 30.6 times faster, and a
changed module about 2.3 times faster in that run. Both incremental cases copy
the complete measured source beside the original. The source-only case changes a
trailing comment and measures incremental lexing plus semantic cache retention.
The changed-module case inserts a revision binding and therefore exercises
lowering, invalidation, checking, staging, and emission.

The original 682.9 ms Rust result was dominated by cloning the complete
inference-variable graph before every speculative ground-union constraint.
Journalled rollback reduced the same cold boundary to about 95--107 ms after
instantiation while preserving diagnostic, HIR, evaluation, and ABI parity. The
transaction invariant and the rest of the type-checking model are specified in
[`TYPECHECKING.md`](../TYPECHECKING.md).

The unchanged resident checker measured 0.348 ms. A changed module spent 15.6 ms
in frontend loading and checking, 1.7 ms preparing HIR, and 0.49 ms emitting
after preparation. The checker retains safely encodable expanded interfaces for
unaffected dependencies in addition to their flat transport form. It reuses
completed compile-time environments and nullary ownership/safety certificates;
reverse-import invalidation discards them when their source graph changes.
Mutable constraint edges are `u32` IDs into a flat append-only arena, while
semantic equality still recognizes row permutation and quantified
alpha-equivalence. The phase split does not identify a dominant finite-row scan,
so explicit SIMD row operations are not justified by this profile. These are
observations, not release constants; rerun the benchmark on the machine and
source being evaluated.
