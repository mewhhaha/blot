# Opt-in staged compiler laboratory

This is the first executable **pure fragment** of the
[staged compiler proposal](../../docs/staged-compiler-proposal.md). It
implements part of M1 and a narrow M2 vertical slice. It is **not** a
replacement for the production compiler, does not compile `gdev`, and does not
establish 100 ms compilation for that application. The full
inference/effect/ownership design, open typed generation, general recursion, and
migration remain unfinished.

The implementation is Rust in the separate `experiments/staged-core/native`
crate. Production Cargo settings and entry points are unchanged. Normal Blot
commands and default compiler Wasm exports never select it, and unsupported
programs are refused instead of silently falling back. Baba's existing lexer,
layout, parser and AST lowering own all surface syntax. There is no handwritten
parser and no JavaScript semantic compiler.

## Run the executable slice

Use the repository's pinned Rust toolchain and locked dependencies:

```sh
cargo build --locked --release --manifest-path experiments/staged-core/native/Cargo.toml \
  --bin staged-prototype
experiments/staged-core/native/target/release/staged-prototype \
  experiments/staged-core/demo.blot /tmp/staged-demo.wasm
node experiments/staged-core/verify.mjs experiments/staged-core/native/target/release/staged-prototype
```

The optional third argument is a **different** edited source file. One session
compiles the original, then the edited contents. Both operations parse source,
validate dependencies, check demanded definitions, execute required static code,
assemble the whole Wasm module and structurally validate it. Outputs are the
specified file and `<output>.edited.wasm`. Identical edit buffers are rejected
by the CLI. The session API also supports unchanged requests as a separate
control; it still reparses and assembles, rather than returning a cached whole
artifact.

Each JSONL line reports initialization separately from `compilationMs`. Source
reads, output writes and printing are outside that interval. This is a **native
Rust laboratory**, not the Deno-hosted production compiler benchmark. Do not
compare its small-fixture latency with the historical application measurements.
The verification script executes the emitted Wasm under Node; it is a caller and
observation harness, not a checker. It tests output agreement across genuine
edits and fresh sessions, not just Wasm structural validity.

## Implemented pieces

- Rank-one let-polymorphic inference, higher-order functions, tuples, structural
  records with inferred open rows, annotations, and an occurs check. Inference
  cells are mutable and request-local; published type schemes and typed core are
  immutable, structurally interned graphs. There are no implicit prelude names.
- Explicit required static execution over checked core nodes, with immutable
  values, lexical closures, conditionals, and bounded `@staged.iterate`. Pure
  calls memoize exact value handles plus observed implementation dependencies.
  Failed and generative calls are not memoized. Known ordinary arguments do not
  cause implicit compile-time execution or specialization.
- First-class computed record/function types, closed typed quotation/splicing,
  and a typed field-accessor generator. A generator returns an internally
  checked core object, not source text that is parsed or inferred again at each
  use.
- Separately cached named definitions. Ordinary callers depend on an interface
  and resolved symbol; static execution additionally observes actual transitive
  implementations. Changed results stop propagating when the relevant immutable
  interface/body identity is unchanged. Fixity headers are explicit inputs.
- One shared runtime code body with separately allocated captured environments.
  The uniform-word calling convention permits polymorphism without a new body
  for each type/value argument. Cached Wasm fragments keep symbolic relocations,
  so editing, inserting or deleting definitions cannot reuse stale indices.
- Opaque nominal type generation with distinct identities per executed fresh
  operation. Unchanged definition queries preserve an already computed
  occurrence, but repeating a generative call does not coalesce its result.

See [the laboratory contract](../../spec/STAGED_PROTOTYPE.md) for the exact
boundaries. All these mechanisms are experimental and independent of production
Blot's normative type/effect/ownership judgment.

## Example and deterministic work checks

`demo.blot` computes a record schema, generates its `left` accessor, infers `id`
and higher-order `apply`, and compiles a runtime closure capturing an integer.
The exported `run(x)` returns `x + 10`. Changing that runtime capture to `20`
produces `x + 20` without rerunning its schema/accessor generators.

For that edit the tests require **one named definition checked, eight reused,
zero static calls, one new core-function fragment, seven reused fragments**.
Annotation type reads and export checking still happen; zero static calls does
not mean zero static steps. The cold program emits eight core-function bodies.

A separate 128-caller regression checks one polymorphic identity body, not 128
specialized copies. Changing one caller checks one named definition and emits
one new function fragment. Shared depth-24 computed schemas add exactly two type
nodes per layer (record plus row). Type import/freeze and static-record emission
retain graph sharing instead of expanding all paths.

These are executable work contracts for this fragment, not application-wide
complexity theorems. Full parsing, dependency comparison, source-slice copying,
export checking, global initialization, helpers, relocation, module assembly,
and Wasm validation still cost work on an edit.

## Validation commands

```sh
cargo fmt --manifest-path experiments/staged-core/native/Cargo.toml -- --check
cargo test --locked --manifest-path experiments/staged-core/native/Cargo.toml
cargo clippy --locked --manifest-path experiments/staged-core/native/Cargo.toml \
  --target wasm32-unknown-unknown --lib -- -D warnings
node experiments/staged-core/verify.mjs experiments/staged-core/native/target/release/staged-prototype
```

The additive `Staged prototype` workflow builds and tests the isolated crate,
including emitted execution. Existing compiler workflows and their gates remain
unchanged. The isolated test command includes the prototype and the shared
frontend tests. Normal production tests remain separate.

The executable tests cover distinct runtime captures; polymorphic records and
let bindings; typed quotation; static versus emitted arithmetic; generativity;
transitive dependencies including memo hits; insertion/deletion/shadowing and
fixity edits; fresh/edited diagnostics; invalid phase crossings; kind/occurs
failures; work and retention limits; and repeated scalar calls with scratch
reclamation. The test script performs 100,000 repeated export calls without
retaining each call's temporary closure/aggregate allocations.

## Reproducible synthetic measurements

[RESULTS.md](RESULTS.md) records final local validation, rejected integration
attempts, source/binary identities and twelve synthetic scaling observations.
[samples.jsonl](samples.jsonl) contains the complete records. Reproduce them
with
`node experiments/staged-core/measure.mjs experiments/staged-core/native/target/release/staged-prototype`.
These measurements exercise small generated programs, not the private
application or the production compiler. They do not establish the 100 ms
application goal.

## Limits and next implementation work

This fragment has **no** effect rows, resource ownership, arrays, variants,
recursive source groups, module/import graph, higher-rank inference, subtyping,
refinement proofs, or generic constraint dictionaries. Nonempty effects,
qualified/deferred parameters, unsupported syntax and production intrinsics are
refused. Empty effects and the inferred-empty placeholder are the only admitted
annotation cases. `Code` is an opaque value carrying a typed closed core root,
not yet an indexed surface `Code<T>` API. Quotation is closed over local slots;
implicit capture of static locals and nested dynamic splicing are refused.
Arbitrary blocked type programs are not yet represented as suspended
obligations.

Type construction and finite iteration exercise forward computation but are not
an implementation of the proposed general-purpose compile-time engine. The
current evaluator is a bounded checked-core interpreter, not a bytecode/JIT
engine. Future extensions must specify scoping, recursion, effects, ownership,
and obligations before broadening acceptance.

The next slice should add scoped typed-generation binders and explicit blocked
static obligations, then effects/ownership and richer schemas. Keep checking the
same work contracts while broadening supported programs. Only after this core
handles representative application semantics should a direct application-level
latency comparison or production migration be considered.
