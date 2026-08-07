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

The production compiler is one Rust/WebAssembly artifact. TypeScript supplies
filesystem access, package resolution, and CLI presentation. Its former semantic
compiler and gpupaper lowering remain only as bounded conformance oracles. An
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
  -> LayoutTokenGraph
  -> CompactCST
  -> SurfaceAST
  -> TypedAST + InferenceFacts
  -> SafeAST + SafetyCertificates
  -> OwnedAST + OwnershipCertificates
  -> StagedProgram
  -> SpecializedProgram
  -> ClosedProgram(ValidatedRuntimeHIR, PublicLayout)
  -> WasmArtifact
```

The implementation may fuse adjacent arrows. Fusion is valid only when the
combined pass could still produce the artifacts and certificates named here. It
may not create a second authority for a fact owned by an earlier phase.

This graph is a logical proof decomposition, not a requirement to allocate ten
different trees. In particular, `TypedAST`, `SafeAST`, and `OwnedAST` mean the
same source program under successively stronger judgments. If an implementation
represents all three as one arena plus validated annotations, that is one
artifact with three proved properties. Treating every lemma as a serialization
boundary increases compiler surface without strengthening the theorem.

The source pipeline is:

```text
source -> Baba lexer -> layout elaboration -> Baba CPU frontend -> compact CST -> fixity fold -> AST
       -> comptime evaluation -> biunification -> safety -> ownership
       -> staging and specialization -> ClosedProgram
       -> direct Rust/WebAssembly emission
```

Baba owns lexing and parsing. Blot owns deterministic layout-token insertion,
source-offset recovery, elaboration, inference, compile-time evaluation, safety,
ownership, specialization, Runtime HIR, ABI policy, the module shell, and direct
WebAssembly emission. Gpupaper owns its independent Core and emitter, which Blot
uses only for bounded conformance comparisons.

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
| public layout  | checked ABI manifest and adapters    | Blot representations and public adapters agree                |
| emitter        | WebAssembly bytes                    | emitted machine steps simulate validated Runtime HIR          |

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
type-directed adaptations, and residual closure signatures. A closure signature
is keyed by its defining module revision and lambda-body expression identity;
the compiler-distributed module certificate serializes the closed signature with
that identity. Representation facts additionally record the concrete call-site
layout of a residual type expression and of an unambiguous structural product
shape. A conflicting observation invalidates the fact; it never selects one
observation by order. Safety owns coverage decisions and relational proofs.
Ownership owns path consumption and reuse permission. Staging owns compile-time
values and residualization decisions. Specialization owns concrete
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

## 9. Complete responsibility inventory

This section inventories what the compiler does, independently of which pass or
implementation currently performs it. A responsibility belongs here when
removing it would change accepted source, diagnostics, runtime observations, a
public artifact, or an explicit compiler command.

### 9.1 Source graph and distribution

| Responsibility                                                        | Required result                         |
| --------------------------------------------------------------------- | --------------------------------------- |
| canonicalize entry and relative paths                                 | one module identity per resolved file   |
| resolve package names and export subpaths                             | logical package-module identities       |
| read and validate package manifests                                   | confined source and built targets       |
| prefer a valid built capsule and fall back to declared source         | the same lowered module graph           |
| read source and included files                                        | exact bytes in the compilation revision |
| resolve `@import` and literal `@include` edges                        | a closed dependency graph               |
| reject cycles and invalid include paths                               | source-oriented diagnostics             |
| retain package-owned relative edges and consumer-owned external edges | relocatable reusable libraries          |
| hash, compress, decode, and validate module capsules                  | a portable lowered AST graph            |
| load the compiler-distributed prelude snapshot                        | a validated AST and checked interface   |
| detect changed sources, includes, capsules, and reverse dependencies  | sound resident invalidation             |

### 9.2 Frontend and elaboration

| Responsibility                                                            | Required result                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| execute Baba's generated lexer plan                                       | deterministic tokens and lexical diagnostics     |
| execute Baba's island parser plan                                         | deterministic compact CST                        |
| reuse an unaffected token prefix after an edit                            | fresh-equivalent incremental frontend output     |
| materialize compact nodes, fields, tokens, and spans                      | a checked CST view                               |
| fold declared fixities                                                    | ordinary binding applications                    |
| build flat AST arenas and validate their references                       | one source representation for later semantics    |
| desugar loops, statement control, guards, elements, and effect sequencing | the small core source language                   |
| assign source origins and compiler-local fresh names                      | stable diagnostics and hygienic control lowering |
| discover imports and includes in lowered expressions                      | complete graph inputs before evaluation          |

### 9.3 Static semantics

| Responsibility                                                                    | Required result                               |
| --------------------------------------------------------------------------------- | --------------------------------------------- |
| construct lexical scopes, `open` frames, recursive groups, and shadowing          | resolved ordinary bindings                    |
| evaluate module functions and compile-time declarations                           | static values and generative identities       |
| implement primitive compile-time behavior                                         | the specified value language                  |
| infer literal, function, record, variant, array, effect, and quantified types     | settled source types                          |
| solve algebraic-subtyping bounds and speculative union choices                    | accepted constraints without leaked mutations |
| check explicit signatures and Rank-N subsumption                                  | declared polymorphism                         |
| infer and close effect rows                                                       | handled effects or public host capabilities   |
| preserve imported compile-time functions for call-site specialization             | value-directed result synthesis               |
| record record fields, constructor sets, adaptations, grants, and declaration tags | type-directed elaboration decisions           |
| check finite pattern coverage                                                     | no missing accepted match arm                 |
| derive and replay relational array-index proofs                                   | safe proof-requiring operations               |
| infer path-sensitive function usage, then track moves, borrows, and exact use     | ownership-safe source execution               |
| erase unused pure bindings without erasing demanded divergence or effects         | source-equivalent live computation            |
| report all source failures at the module and span that caused them                | ordered diagnostics                           |

### 9.4 Normalization and representation closure

| Responsibility                                                                                | Required result                             |
| --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| distinguish static values from residual runtime computations                                  | phase-safe erasure                          |
| reuse compile-time results already demanded by checking                                       | no second semantic derivation               |
| inline or apply imported module closures under concrete arguments                             | consumer-specific program meaning           |
| specialize structural calls by concrete shape                                                 | monomorphic runtime operations              |
| instantiate higher-order representation variables from concrete arguments                     | closed nested closure signatures            |
| solve positive recursive representation equations by their least fixed point                  | a finite graph with private recursive roots |
| preserve compiler-local control envelopes while erasing their payload wrappers                | one runtime sum for statement control       |
| erase scalar refinements without changing their concrete layout                               | equal layouts for refined and open facts    |
| erase first-class effect values at explicit sequencing boundaries                             | one checked nullary call                    |
| closure-convert runtime free variables into explicit function parameters                      | lexically minimal residual environments     |
| unfold static structural folds around dynamic scalar work                                     | direct runtime projections                  |
| specialize handlers, effect identities, seals, and generated descriptors                      | closed runtime identities                   |
| preserve source evaluation and host-request order                                             | observationally equivalent residual code    |
| choose concrete scalar, product, sum, Store, text, SIMD, and private indirect representations | no open runtime type                        |
| turn ownership and bounds evidence into permitted target operations                           | checked mutation and eliminated checks      |
| identify runtime exports and their source types                                               | a closed public program boundary            |

### 9.5 Runtime program and ABI

| Responsibility                                                                 | Required result                   |
| ------------------------------------------------------------------------------ | --------------------------------- |
| build typed blocks, values, operations, signatures, and terminators            | closed runtime control-flow graph |
| lower functions, closures, recursion, cases, effects, arrays, text, and SIMD   | explicit runtime operations       |
| validate IDs, types, dominance, edges, effect closure, and ownership use       | internally valid runtime program  |
| admit or refuse public source types under ABI policy                           | representable imports and exports |
| plan canonical layouts for scalars, text, arrays, records, variants, and seals | one boundary representation       |
| generate stable host import names and export names                             | linkable WebAssembly interface    |
| generate lift, lower, allocator, post-return, and malformed-input checks       | caller-safe adapters              |
| serialize one canonical manifest and embed exactly those bytes                 | sidecar/custom-section agreement  |

### 9.6 Machine lowering and operational tooling

| Responsibility                                                                                                | Required result                      |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| translate runtime operations to validated gpupaper Core or an equivalent direct plan                          | language-independent machine program |
| lower trapping arithmetic, wrapping arithmetic, comparisons, control, memory, host calls, and SIMD            | specified WebAssembly behavior       |
| emit UTF-8 validation, text comparison, integer formatting, relocation, and allocation support when reachable | complete runtime support             |
| encode deterministic WebAssembly and validate it                                                              | final module bytes                   |
| expose parse, AST, check, ownership, evaluation, test, package, and build commands                            | observable compiler tooling          |
| retain reference, conformance, and emitted-Wasm executions                                                    | differential correctness evidence    |
| cache frontend, interfaces, analyses, static values, runtime program, and final artifacts by valid revision   | incremental compilation              |

The inventory is intentionally longer than the pass graph. The pass graph says
which theorems compose; the inventory says how much product behavior exists.
Simplification must remove or combine mechanisms while preserving the required
results. Merely putting the same responsibilities in one file is not a collapse.

## 10. Present implementation shape

This is an operational snapshot recorded on 2026-08-06, not a permanent
contract. The two implementations do not currently materialize the logical
artifact graph in the same way.

The production compiler has one semantic session. The TypeScript host resolves
files and packages, then supplies source or a validated portable AST to that
session. For one semantic revision, the session checks, evaluates the static
fragment, proves safety and ownership, specializes, and elaborates Runtime HIR.
Those services close into one persistent artifact:

```text
AST + resolved dependencies
  -> close
  -> ClosedProgram(ValidatedRuntimeHIR, PublicLayout)
  -> direct Runtime-HIR emitter
  -> WasmArtifact
```

`ClosedProgram` is the cache boundary. It owns the only Runtime HIR for the
revision and the only `PublicLayout`. The layout produces the manifest bytes,
capability list, flattened signatures, memory layouts, variant tags, and
post-return obligations consumed by the emitter. Compilation memoizes the final
artifact inside the same closed value.

Constants and residual computations are ordinary Runtime-HIR functions handled
by one emitter. The former constant evaluator, template emitter, and dynamic
emitter selection have been deleted. Structured constant results therefore use
the same canonical-result adapter as effectful results.

The former TypeScript semantic pipeline is not reachable from `build` or the
public `Compiler`. Small differential tests may call it explicitly as an oracle.
Its alternate lowering routes and gpupaper adapter are test infrastructure, not
production fallbacks, and may reject programs outside the bounded comparison set
without changing the production language.

The current gpupaper Rust crate serializes an already planned WebAssembly
module; gpupaper Core construction and Core-to-plan lowering remain TypeScript.
Linking that crate would retain both Blot's runtime lowering and gpupaper's
TypeScript lowering rather than collapse them. Blot therefore selected the
permitted alternative: one direct Rust emitter in production, with gpupaper
external to the production artifact.

The logical safety, ownership, and inference judgments remain distinct. Their
intermediate Rust representations are request-local; only the closed result is
persistent. This is fusion at the semantic and cache boundary, not a claim that
the different proofs have become one type-system rule.

## 11. Collapse laws

The following laws identify mechanisms that may be combined.

### 11.1 One traversal, one authority

If checking determines a fact needed to construct runtime code, checking should
write that decision into the node that reaches runtime elaboration:

```text
infer(e) = (A, facts)    lower(e, facts) = r
------------------------------------------- fuse-elaboration
elaborate(e) = (r : A)
```

This does not merge ownership into the type lattice or weaken certificate
replay. It replaces identity-keyed transport with a typed residual node. Facts
needed only to justify that node are consumed while constructing it.

### 11.2 Logical proofs need not be material trees

Coverage, refinement, and ownership remain distinct judgments because their
metatheory differs. They need not produce `SafeAST` and `OwnedAST` copies. A
validated residual node can record the finite evidence needed by a later
independent checker, while the proof relates to the same stable `NodeId`.

### 11.3 One runtime language

For a fixed target, a program must not choose among constant, residual, legacy,
and dynamic runtime languages. Constants are ordinary zero-input runtime
programs and should pass through the same emitter:

```text
emit(constantFold(core)) = optimize(emit(core))
```

up to permitted optimization differences. A separate constant emitter is
justified only by a measured release requirement large enough to pay for a
second ABI and runtime semantics implementation.

### 11.4 One ABI plan

Manifest generation and adapters are two projections of one checked layout plan:

```text
planAbi(publicTypes) = L
manifest = describe(L)
adapters = emit(L)
```

No emitter may independently recalculate record offsets, variant layouts,
flattening limits, post-return obligations, or text ownership.

### 11.5 One production compiler

Differential implementations are valuable while establishing parity. They are
not a permanent architecture. After one implementation satisfies the release
gates, the other becomes a bounded oracle over a deliberately small core or is
deleted. A complete second frontend, evaluator, type checker, ownership pass,
runtime lowering, and ABI backend doubles the number of places in which the
language can accidentally exist.

## 12. Minimal compiler architecture

The production architecture is one Rust compiler inside one WebAssembly
artifact, with TypeScript restricted to filesystem access, package resolution,
and CLI presentation:

```text
SourceGraph
  -> Baba compact CST
  -> SurfaceArena
  -> close
  -> ClosedProgram(RuntimeHIR, PublicLayout)
  -> direct Rust emitter
  -> WasmArtifact
```

`SurfaceArena` is the only untyped tree. `ClosedProgram` is the only persistent
post-analysis compiler artifact. Its Runtime HIR contains flat stable IDs,
settled runtime types and effects, residual operations, concrete
representations, and source origins. Its `PublicLayout` contains the closed
caller representation. It contains no live inference variable, open structural
row, or unresolved effect. Runtime HIR schema 2 adds an `indirect` type plus
`indirect.make` and `indirect.load`. Representation closure allocates the
recursive root ID only for a closure body named by the checked recursive-SCC
certificate, before lowering its constructor body. It fills the target edge
after the positive body is known and rejects a root with no finite constructor
case. An unresolved result without that certificate is a lowering refusal, not
implicit permission to invent indirection. The emitter stores the target in
call-local scratch memory and flattens a recursive edge to one `i32`;
public-layout construction refuses that private type under ABI 1.

The central judgment combines type elaboration with normalization:

```text
Gamma ; Phi ; K |- e => Static(v : A)
Gamma ; Phi ; K |- e => Dynamic(r : A ! E)
```

Constraint solving remains a service used by the judgment. Compile-time
application recursively invokes the same judgment with a static argument.
Dynamic results append typed Runtime-HIR nodes immediately. Structural folds
over static labels unfold before a dynamic node is committed. This is
normalization-by-evaluation for the static fragment and typed elaboration for
the residual fragment, not an evaluator followed by an unrelated lowering. The
current implementation closes these stages behind one request and persistence
boundary; progressively producing final nodes during checking is the remaining
internal fusion opportunity.

Ownership remains a separate flow analysis over the closed residual control-flow
graph. This preserves the decision that linearity is not part of the subtyping
lattice while eliminating a second source-AST traversal and the transitive
ownership-map merge. Coverage and relational reasoning run while elaborating the
operation they justify; compact replay evidence may remain on Runtime HIR until
validation consumes it.

Gpupaper does not currently expose its Core construction and lowering as a Rust
library boundary. Blot therefore retains Runtime HIR as `ClosedProgram` and has
exactly one direct emitter. `PublicLayout` stays Blot-owned and supplies the
module shell and canonical adapters. Adding a linked gpupaper emitter is valid
only if it replaces the direct emitter; retaining both is the rejected state.

This architecture makes the following current concepts unnecessary as production
mechanisms:

| Remove                                        | Replacement                               |
| --------------------------------------------- | ----------------------------------------- |
| TypeScript semantic compiler                  | thin host plus bounded conformance oracle |
| transitive `CheckResult` fact-map assembly    | stable typed Runtime-HIR nodes            |
| separate staged AST                           | static/dynamic result of elaboration      |
| legacy gpufuck surface module                 | direct closed Runtime-HIR construction    |
| constant Runtime HIR path                     | ordinary constant folding in one HIR      |
| canonical-text versus constant emitter choice | one ABI plan and emitter                  |
| gpupaper production lowering                  | bounded external conformance oracle       |
| duplicate portable AST and snapshot envelopes | one versioned flat module artifact        |

The architecture deliberately does not remove Baba, source effects, algebraic
subtyping, ownership, safe arrays, compile-time modules, canonical ABI checks,
or differential testing. Those are language or correctness responsibilities. It
removes repeated representations and authorities around them.

## 13. More radical language levers

If the minimal compiler remains too large after the architectural collapse, the
remaining complexity is language complexity. The following changes are ordered
by expected leverage, not by compatibility.

1. **Stratify type-relevant computation.** Permit only a total, pure static
   fragment to produce types or choose a result type. Arbitrary compile-time
   programs may still generate values and code, but inference never has to run
   them. This removes the deepest checker/evaluator recursion and makes module
   interfaces independently cacheable. It gives up the claim that every value
   can participate equally in typing.
2. **Make runtime aggregates nominal.** Keep structural records as compile-time
   descriptions, but require runtime records and variants to be declared or
   generated into nominal layouts before ordinary functions consume them. This
   removes open runtime shape specialization, field-set propagation, and most
   representation cloning. It trades structural ergonomics for predictable
   separate compilation.
3. **Make all array access total at the language boundary.** `get` and `set`
   return an explicit success/failure sum; an optimizer removes checks from
   loops and comparisons it proves. This deletes proof-required source
   operations, stable array identities, and relationship certificates. It may
   emit more checks until range analysis matures.
4. **Use affine ownership only.** Remove exact linear consumption and borrowing;
   values may be moved at most once and may be dropped. This substantially
   simplifies branch joins and closure obligations while retaining safe
   destructive reuse. It weakens protocols that rely on exactly-once use.
5. **Remove arbitrary user-defined fixity.** Parse a small fixed operator set or
   require named calls. This removes one frontend environment and fold, but its
   leverage is small compared with staging and structural specialization.

The first lever is the only language change likely to rival the architectural
collapse. Types-as-values plus imported compile-time dispatch means inference,
evaluation, module caching, and specialization are necessarily mutually
dependent. No data layout makes that dependency disappear.

## 14. Decision experiments

The collapse should be tested by deletion in this order:

1. **Complete:** `build` and the public `Compiler` route through Rust; the
   TypeScript path is callable only from explicit oracle tests.
2. **Complete:** constant programs use the residual emitter, including
   structured canonical results; the constant evaluator and emitter are gone.
3. **Complete at the persistence boundary:** one `ClosedProgram` owns Runtime
   HIR and the compiled artifact for a semantic revision. Flattening the
   remaining request-local analysis arenas is a separate internal optimization.
4. **In progress:** recursive and higher-order closure signatures are attached
   to stable `(module revision, lambda body)` identities and cross the prelude
   snapshot as checked facts. Call-site representation substitutions, structural
   product-shape facts, globally fresh representation holes, and imported source
   origins now close recursive functions without guessing from captured values.
   Progressively attach the remaining settled types, deleting request-local fact
   maps as their last consumers move into elaboration.
5. **Complete:** one `PublicLayout` owns manifest bytes, capabilities, canonical
   layout, and the data consumed by adapters.
6. **Complete:** gpupaper's available Rust crate does not expose Core lowering,
   so the direct Rust emitter is the sole production emitter and gpupaper is an
   external oracle.
7. Replace the package capsule and prelude snapshot with one flat module
   artifact whose optional sections are AST, checked static interface, and
   `ClosedProgram`, all keyed by the same semantic schema.

After each experiment, count concepts deleted as well as milliseconds saved. The
acceptance signal is fewer authoritative representations and fewer complete
semantic traversals with equal observations. A faster path that leaves both old
and new mechanisms in production makes the compiler more complicated and is a
failed simplification experiment.
