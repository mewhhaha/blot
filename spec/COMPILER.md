# Compiler model

## Status and scope

This document is the umbrella specification for compiling Blot. It defines the
artifacts passed between phases, the facts each phase may trust, and the theorem
that connects source observations to emitted WebAssembly observations. Detailed
judgments live in the references listed in [`README.md`](README.md).

[`LANGUAGE.md`](../LANGUAGE.md) remains normative for accepted source and its
meaning. [`PAPER.md`](PAPER.md) develops the target language model.
[`TYPECHECKING.md`](TYPECHECKING.md) is a sub-reference of this specification,
not a second definition of the language.

The specification applies to both compiler implementations. The production
TypeScript path delegates validated Core emission to gpupaper. The experimental
Rust/WebAssembly path implements the same phase contracts in one artifact. An
implementation boundary is not a semantic boundary.

## 1. Inputs, outputs, and observations

Let a source graph be

```text
G = (root, files, resolves, includes)
```

where `files` maps canonical module identities to exact bytes, `resolves`
records import edges, and `includes` records compile-time external inputs. A
target policy `tau` contains the ABI major, enabled Runtime-HIR features, and
emission policy. Compilation is a partial, deterministic judgment:

```text
G ; tau |- compile(root) => Artifact(W, M, D)
G ; tau |- compile(root) => Diagnostics(D)
```

`W` is a WebAssembly module, `M` is the canonical ABI manifest, and `D` is the
ordered diagnostic set. Success requires `D` to be empty. The bytes of `M` in
the sidecar and the `blot:abi` custom section are equal.

The observable behavior of a closed source computation is one of:

```text
Observation A ::=
    Return A
  | Request(effect, operation, argument, continuation)
  | Trap(reason)
  | Diverge
```

Allocation identities, compiler identities, private constructor numbers,
administrative reductions, and cache hits are not observations. Host operation
order, operation arguments, return values, and classified traps are.

## 2. Artifact graph

```text
SourceGraph
  -> TokenGraph
  -> CompactCST
  -> SurfaceAST
  -> TypedAST + InferenceFacts
  -> SafeAST + SafetyCertificates
  -> OwnedAST + OwnershipCertificates
  -> StagedProgram
  -> SpecializedProgram
  -> ValidatedRuntimeHIR
  -> ValidatedCoreModule + AbiManifest
  -> WasmArtifact
```

The implementation may fuse adjacent arrows. Fusion is valid only when the
combined pass could still produce the artifacts and certificates named here. It
may not create a second authority for a fact owned by an earlier phase.

The source pipeline is:

```text
source -> Baba CPU frontend -> compact CST -> fixity fold -> AST
       -> comptime evaluation -> biunification -> safety -> ownership
       -> staging and specialization -> Blot Runtime HIR
       -> gpupaper Core -> Rust/WebAssembly emission
```

Baba owns lexing and parsing. Blot owns elaboration, inference, compile-time
evaluation, safety, ownership, specialization, Runtime HIR, ABI policy, the
module shell, and the Runtime-HIR-to-Core adapter. Gpupaper owns validation and
emission of its language-independent Core. The full Rust compiler may
internalize these implementation layers but must preserve the ownership of their
meanings.

## 3. Pass contract

For a pass `P : X -> Y`, write

```text
x valid_X    P(x) = y
---------------------- P-preservation
y valid_Y
```

and let `erase_P : Y -> X_sem` discard annotations introduced by `P`. The
semantic obligation is a forward simulation:

```text
x ~ erase_P(y)    x -> x'
--------------------------- P-simulation
exists y'. y ->* y' and x' ~ erase_P(y')
```

The concrete contracts are:

| Pass           | Produces                             | Must establish                                                |
| -------------- | ------------------------------------ | ------------------------------------------------------------- |
| frontend       | compact CST and elaborated AST       | deterministic parse, faithful spans, defined desugaring       |
| inference      | typed AST and inference facts        | declarative typing, principal rank-1 result where promised    |
| safety         | coverage and relational certificates | no missing finite case or forged proved operation             |
| ownership      | structural use certificates          | no double move, illegal borrow, or path-dependent linear loss |
| staging        | residual program and phase facts     | erased compile-time values cannot be observed at runtime      |
| specialization | representation-closed program        | no residual polymorphic shape or dynamic structural fold      |
| Runtime HIR    | validated monomorphic graph          | every operation has a closed target representation            |
| Core adapter   | validated Core and ABI manifest      | Blot representations and public adapters agree                |
| emitter        | WebAssembly bytes                    | emitted machine steps simulate validated Core                 |

The detailed contracts are in [`FRONTEND.md`](FRONTEND.md),
[`TYPECHECKING.md`](TYPECHECKING.md), [`SAFETY.md`](SAFETY.md),
[`STAGING.md`](STAGING.md), and [`RUNTIME.md`](RUNTIME.md).

Package manifests and distributed reusable-module artifacts are specified in
[`PACKAGES.md`](PACKAGES.md). A module capsule reconstructs the validated output
of the lowering boundary in this pass graph; it does not create an alternate
checking or specialization judgment.

## 4. Fact ownership

The compiler carries a finite fact store keyed by stable identities in the
artifact that consumes the facts:

```text
Facts = InferenceFacts + PhaseFacts + SafetyCertificates
      + OwnershipCertificates + RepresentationFacts
```

Inference owns field sets, constructor sets, settled types, effect identities,
and type-directed adaptations. Safety owns coverage decisions and relational
proofs. Ownership owns path consumption and reuse permission. Staging owns
compile-time values and residualization decisions. Specialization owns concrete
representations. A later pass verifies and consumes these facts; it does not
infer them again.

An identity is valid only within its source revision. Serializing a fact
requires a closed certificate whose premises name stable serialized identities.
Mutable inference variables and live AST object identities never cross a cache,
worker, or compiler-process boundary.

## 5. Error classes

The result distinguishes three failures:

```text
Diagnostic       source does not satisfy the language judgment
TargetRefusal    public ABI or explicitly experimental target lacks a feature
InvariantFailure an earlier compiler contract was violated
```

Diagnostics accumulate at the phase that has enough source evidence to explain
them. A missing inference or representation fact after successful checking is an
invariant failure, not a new diagnostic. A production target may not turn a
well-typed closed internal program into a target refusal because specialization
failed to close a structural type.

## 6. Whole-compiler theorem obligation

Let `R_A` relate source values of type `A` to canonical ABI values, and let
`liftHost` relate a conforming caller to source host operations. If:

1. `G ; tau |- compile(root) => Artifact(W, M, {})`;
2. the entry module is closed except for the capabilities declared by `M`;
3. caller inputs satisfy `M` and malformed inputs take the specified ABI trap;
4. every pass preservation and simulation lemma holds; and
5. the WebAssembly engine implements the WebAssembly Core specification;

then for every conforming host trace:

```text
observe_wasm(W, host) = R(observe_source(G, root, liftHost(host)))
```

where `R` preserves returns, host requests, classified traps, and divergence
while erasing private allocation and administrative steps. The proof decomposes
along the pass graph; [`CORRECTNESS.md`](CORRECTNESS.md) records the dependency
order and present evidence.

## 7. Determinism

For fixed `G`, `tau`, compiler version, generated parser plan, and dependency
versions, compilation is deterministic:

```text
compile(G, tau) = r1    compile(G, tau) = r2
--------------------------------------------
r1 = r2
```

Equality includes diagnostic order, manifest bytes, and WebAssembly bytes. Fresh
internal identities must therefore be allocated by deterministic traversal or
canonicalized before serialization. Parallel scheduling may change completion
order but not committed artifact order.

## 8. Incrementality and cost

Incremental execution is memoization of the same compilation judgment. It may
skip a pass only when a revision key proves that every input observed by that
pass is unchanged and its closed output certificate validates. This is specified
in [`INCREMENTAL.md`](INCREMENTAL.md).

A content hash establishes identity, not authority. In particular, an untrusted
package cannot justify a checked interface by hashing an interface it supplied
itself. Reusing semantic judgments across a trust boundary requires either a
replayable proof certificate or an attestation rooted in the compiler
distribution. The compiler-distributed prelude snapshot uses the latter: its
portable AST and closed interface are a separate package artifact beside the
checker WebAssembly, and the artifact build regenerates both from the same
source revision by running the ordinary frontend and checker. Distribution
integrity covers the pair. This changes where one derivation is stored, not the
module's scope, identity, or language meaning.

Let `S` be such a distributed snapshot and `C` the compiler semantic schema. Its
reuse rule is:

```text
frontend_C(source) = ast    check_C(ast) = interface
distribute(W_C, S(ast, interface))    decode_C(S) = (ast, interface)
------------------------------------------------------------------- distribution-reuse
check_C(ast) = interface
```

The premises are a release-build obligation over one distribution. Runtime
loading resolves `blot:prelude` to the adjacent snapshot through the ordinary
module loader, then validates the portable AST arena, certificate schema, closed
flat type arena, and all arena references before installing the memoized result.
The MessagePack envelope is a transport encoding of those existing artifacts,
not another AST schema. If compile-time specialization needs values represented
by the AST, the compiler evaluates the validated AST once per session and
retains its result; the cached interface never substitutes an asserted runtime
value.

Performance is measured by phase work, not by repository boundaries. Cold, warm,
resident, unchanged-revision, source-only-edit, and semantic-edit timings are
different experiments. [`COST_MODEL.md`](COST_MODEL.md) defines them and the
conditions under which a faster compiler remains the same compiler.
