# The Rust Backend

The generated
[current implementation report](../generated/CURRENT_IMPLEMENTATION.md) is the
concise, CI-checked inventory of this production path.

```bash
pnpm compiler:build
pnpm conformance
pnpm blot build examples/owned_quicksort.blot
```

Blot has one semantic compiler implementation. The checked-in Rust source is
compiled to `generated/compiler/compiler.wasm`; the TypeScript process hosts
that artifact, resolves the source graph, runs Baba's syntax frontend, and
passes compact portable ASTs and included bytes into a resident compiler
session. It does not check, evaluate, specialize, analyze ownership, construct
Runtime HIR, plan the ABI, or emit program Wasm.

The mathematical pass contracts live in
[`spec/COMPILER.md`](../spec/COMPILER.md) and
[`spec/RUNTIME.md`](../spec/RUNTIME.md). This document records the current
implementation boundary and its deliberate target restrictions.

## Artifact boundary

`pnpm compiler:build` builds the pinned Rust target, snapshots the dependency-
free prelude, and writes the compiler artifact manifest. The manifest binds:

- the compiler Wasm SHA-256;
- the compiler-host ABI version;
- the prelude snapshot SHA-256;
- the pinned Rust toolchain; and
- a deterministic digest of every Rust compiler input.

The compiler Wasm and manifest are derived outputs. The prelude snapshot is
tracked because it is the language's distributed ordinary-module interface. The
Node host refuses a missing, mismatched, or incompatible artifact before it
creates a compiler session. A caller supplying custom compiler bytes must also
supply the matching prelude snapshot and thereby owns the trust decision for
that pair.

One `Compiler` owns one resident Rust session. Requests are serialized, while
unchanged loaded revisions reuse prepared Runtime HIR and emitted artifacts.
Source, import, include, or capsule changes invalidate the affected root.

## Compiler path

```txt
resolved source graph
  -> Baba lexer/layout/island parser
  -> compact CST -> Rust AST
  -> comptime evaluation
  -> biunification
  -> ownership and safety
  -> specialization and residual evaluation
  -> validated Runtime HIR
  -> ABI 1 closure
  -> emitted WebAssembly
```

The package format carries the canonical Rust-exported AST. Loading a package
therefore validates and installs the same syntax artifact that source loading
would have produced; there is no TypeScript AST or checker dialect.

Rust exposes source checking, tooling analysis, evaluation, tagged tests,
portable AST export, Runtime-HIR preparation, and compilation. Diagnostics are
source failures with real spans. Unsupported target policy is returned as a
target refusal. A checked fact missing during lowering is an invariant failure,
not a synthetic source diagnostic.

## Evaluation and conformance

There are two authoritative observations of executable code:

| Observation    | Purpose                                                       |
| -------------- | ------------------------------------------------------------- |
| Rust evaluator | `const`, comptime, interactive evaluation, and test execution |
| emitted Wasm   | production execution through Blot Core Wasm ABI 1             |

`pnpm conformance` requires both to agree on representative scalar and owned-
collection programs, including owned quicksort. Independent evaluators may be
used as research oracles, but they are not compiler implementations and cannot
override the language checker.

## Inference feeds lowering

The checker records the facts residual lowering is allowed to trust:

- expression runtime types;
- closure signatures and recursive closure identities;
- complete record and constructor sets;
- declaration tags;
- ownership contracts; and
- concrete compile-time values needed by specialization.

The prelude snapshot contains its AST and checked certificate, including closure
facts. Installing it inflates those facts and deterministically reconstructs the
module value without reintroducing a second type checker.

Sequenced effect results obey the value restriction. `use name <- computation`
binds one monomorphic runtime value, so later uses refine the same result and,
for an entry-module capability, its host signature. Pure `let` and `const`
retain ordinary generalization.

Canonical `@satisfies` requirements remain representation evidence during
residual evaluation. This matters for an empty collection: `[T]` determines a
Store element layout even when no element exists at the first recursive call.

## Runtime HIR

Runtime HIR is typed, closed, ownership-annotated, and source-spanned. Recursive
closures become internal functions with explicit runtime captures and
`call.direct` edges. Dynamic branches become blocks and joins. Closed function
choices are defunctionalized inside the program; an open source set is refused.

Current scalar lowering covers signed integers, `f32`, `f64`, comparisons,
conversions, and the supported SIMD families. Text lowering covers append,
length, integer conversion, comparison, and substring search. The emitted
substring helper searches UTF-8 bytes, which is equivalent to source substring
semantics because both operands have already crossed validated UTF-8 text
boundaries.

Arrays use the generic Store operations: empty, length, read, persistent or
owned-reuse write, growth, split, and take. Regions reuse those layouts while
keeping split/join authority in ownership evidence. Quicksort remains ordinary
Store and control-flow code; there is no quicksort, partition, or collection
specialization primitive.

## V8 and WebAssembly 3.0

The production module is standard WebAssembly 3.0 and keeps the existing ABI 1
memory32 boundary. The manifest declares the core specification and the exact
feature families used by each artifact. Current emission uses bulk-memory,
internal multi-value results, fixed-width SIMD when the source requests vector
operations, and direct tail calls.

A `call.direct` whose result is returned immediately, or forwarded through only
empty join blocks to the return, lowers to `return_call`. The backend verifies
parameter and result flattening before emission. This removes recursive Wasm
frames without changing Blot's source observation model. Export wrappers are not
tail-called because they must restore allocation checkpoints and perform
canonical result lowering.

CI validates and executes the target without feature flags on the current Node
24 LTS and Node 26 Current V8 lines. The detailed adoption and deferral
rationale is in [`wasm-target-profile.md`](wasm-target-profile.md).

## Module authority and host effects

An entry module's `module with init` record is its complete host authority. A
reached field becomes a typed Wasm import; an unused field does not. The
operation's argument and result are inferred from the monomorphic source flow.
An otherwise unconstrained result becomes `Unit`, while an unconstrained input
is refused because the host ABI would have no representation.

Host effects declared with `@effect.host` use the same capability mechanism.
Canonical text and nested structural results are bounds-checked and UTF-8-
validated before residual code observes them.

An effectful module top level cannot be replayed separately for multiple public
runtime fields. Such a module must return one runtime value or move the effect
inside a returned function.

## Public ABI

Blot Core Wasm ABI 1 is memory32 with canonical UTF-8 text adapters. Public
exports contain only closed first-order types. The emitter derives the sidecar
manifest and the `blot:abi` custom section from one byte sequence, and the host
requires them to agree.

Compiler-private layouts never cross that boundary. These include recursive
indirections, Store headers, defunctionalized closure-choice tags, and internal
capture products. Exporting a function choice is refused even when it is valid
inside Runtime HIR.

## Deliberate target restrictions

The current backend refuses rather than guessing when:

- a dynamic primitive has no Runtime-HIR operation;
- a dynamic condition is not Boolean;
- dynamic branches have incompatible runtime layouts;
- a runtime function has no settled first-order signature;
- a dynamic sum requires more than the supported binary residual dispatch;
- a deferred function escapes known application and would require a runtime
  thunk or public deferred calling convention;
- a function choice has an open source set or crosses the public ABI; or
- a compiled module has no runtime export.

These are production-compiler boundaries. Adding one requires a Rust semantic
implementation, a Runtime-HIR/ABI account where applicable, executable evidence,
and matching updates to the language and compiler specifications.
