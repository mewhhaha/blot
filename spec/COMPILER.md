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

Blot has one compiler contract and one semantic implementation. Rust owns every
semantic pass and is distributed as a compiler Wasm artifact. Node hosts that
artifact, resolves source graphs, and provides syntax-only tooling through
Baba's generated frontend. Git tracks the Rust implementation and generated
prelude snapshot, while successful CI runs publish exact compiler bytes with a
content hash, host-ABI version, and compiler-input identity. Deno, a native Rust
process, Cargo, and WebGPU are outside an ordinary compilation boundary.

Baba's Wasm runtime lexes layout-elaborated source. Its CPU island executor
parses the general-profile plan and returns the compact CST. The Rust emitter
receives only validated Blot Runtime HIR. Blot owns every semantic judgment
between those boundaries; neither Wasm component is permitted to reinterpret
Blot source semantics. An implementation boundary is not a semantic boundary.

The Node CLI exposes `ast`, `check`, `run`, and `build`. `run` executes a
zero-parameter default or sole runtime export when the module needs no host
capabilities. It copies direct and canonical-memory values and completes owned
indirect results through their declared post-return. Evaluation of arbitrary
host-dependent programs, ownership reports, formatting, and package construction
remain development tools outside this CLI boundary. `pnpm conformance` compares
the Rust evaluator, emitted Wasm, and explicit GPU oracle where that oracle
supports the program. There is no second checker whose acceptance can override
the Rust judgment.

## 1. Inputs, outputs, and observations

Let a source graph be

```text
G = (root, files, resolves, includes)
```

where `files` maps canonical module identities to exact bytes, `resolves`
records import edges, and `includes` records compile-time external inputs. A
target policy `tau` contains the public ABI major and concrete Wasm target. The
current default is `(1, wasm-simd128)`. Runtime-HIR schema compatibility is
internal to a compiler/backend distribution and is therefore an invariant, not a
caller-selected target policy. Compilation is a partial, deterministic judgment.

The packaged compiler reserves an 8 MiB Rust/Wasm stack. This is compiler-host
memory for recursive inference, specialization, and ownership proofs; it does
not alter the memory or stack of emitted Blot programs. The artifact build owns
the linker setting so local and hosted compilers have the same proof limit.
Source closure calls are trampolined during evaluation, so recursive Blot code
does not consume the host VM call stack.

The judgment is:

```text
G ; tau |- compile(root) => Artifact(W, M, D)
G ; tau |- compile(root) => Diagnostics(D)
G ; tau |- compile(root) => TargetRefusal(T)
G ; tau |- compile(root) => InvariantFailure(I)
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
  -> LayoutTokenGraph
  -> BabaWasmTokenGraph
  -> BabaGeneralCompactCST
  -> SurfaceAST
  -> TypedAST + InferenceFacts
  -> SafeAST + SafetyCertificates
  -> OwnedAST + OwnershipCertificates
  -> TypedCore + ProgressiveHIRState
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
source -> Baba lexer -> layout elaboration -> Baba CPU frontend -> compact CST -> fixed operator fold -> AST
       -> comptime evaluation -> biunification -> safety -> ownership
       -> staging and specialization -> validated Runtime HIR
       -> ABI closure -> Rust/Wasm emission -> ClosedProgram
```

Baba owns lexing and parsing. Blot owns deterministic layout-token insertion,
source-offset recovery, elaboration, inference, compile-time evaluation, safety,
ownership, specialization, Runtime HIR, ABI policy, and the module shell. The
Rust backend owns target planning and binary emission. The CI-built Blot
compiler Wasm is the semantic compiler used by ordinary Node commands and
production distributions alike.

`TypedCore` is the first shared value/computation schedule. Each Core node has a
stable node identity and a structural type-representation identity. A
`ProgressiveHIRState` is either pending, with the unresolved structural fold or
finite specialization choice named explicitly, or settled, with closed type,
effect, representation, ownership-permission, and safety-evidence identities. A
settled state may commit its final Runtime-HIR contribution immediately. There
is no state that means "pending with a fallback representation".

### 2.1 Production compiler distribution

`compiler.wasm` is derived output. A distribution manifest binds its byte length
and SHA-256 digest to the pinned Rust toolchain, compiler-host ABI, generated
prelude digest, and exact closure of inputs that affect the compiler. A consumer
may install an artifact only after validating every field. A mismatch is not a
source diagnostic and must not be silently accepted as a nearby compiler
revision.

Each pull-request or main-branch CI run builds this artifact once and uses those
same bytes for conformance, benchmarks, and the downloadable runnable workspace.
The raw compiler artifact and workspace are retained as CI products; neither is
a second semantic authority. Local development may reproduce the artifact with
the pinned build procedure or download an artifact for matching compiler inputs.
Node compilation requires the artifact but never starts Cargo or a native
compiler implicitly.

`compiler/protocol.json` is the single source for transport and certificate
versions. `compiler/language.json` is the single source for fixed operator
spelling, precedence, and targets. Generation produces both Rust and TypeScript
consumers; CI rejects stale copies. The generated `language-health.json`,
diagnostic-code union, and `STDLIB.md` inventory the remaining intrinsic,
diagnostic, hotspot, and public-library surfaces so growth is reviewed as an
explicit contract change.

The distribution has one host adapter with the resident `Compiler` shape:
`check`, `checkSource`, `prepare`, `compile`, and `destroy`. The adapter
resolves the exact source graph, installs every source or portable-AST module
and include in one Rust session, and configures import edges before requesting a
semantic phase. Its transport is not a fourth failure class: located source
failures become ordinary source diagnostics, explicit target refusals become
`TargetRefusal`, and failures after successful checking or Runtime-HIR
validation become `InvariantFailure` without fabricated spans.

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

| Pass           | Produces                                | Must establish                                                                    |
| -------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| frontend       | compact CST and elaborated AST          | deterministic parse, faithful spans, defined desugaring                           |
| inference      | typed AST and inference facts           | declarative typing, principal rank-1 result where promised                        |
| safety         | coverage and relational certificates    | no missing finite case or forged proved operation                                 |
| ownership      | structural use and lineage certificates | no double move, illegal borrow, omitted extraction, or path-dependent linear loss |
| typed Core     | value/computation schedule and node IDs | live order, source origin, type representation, and proof markers agree           |
| staging        | residual program and phase facts        | erased compile-time values cannot be observed at runtime                          |
| specialization | representation-closed program           | no residual polymorphic shape or dynamic structural fold                          |
| Runtime HIR    | validated monomorphic graph             | every operation has a closed target representation                                |
| public layout  | checked ABI manifest and adapters       | Blot representations and public adapters agree                                    |
| emitter        | WebAssembly bytes                       | emitted machine steps simulate validated Runtime HIR                              |

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

Inference owns field sets, constructor sets, checked application types, effect
identities, type-directed adaptations, and residual closure signatures. Each
retained application type is keyed by its defining module revision and
expression identity; a closure signature uses the same key shape with its lambda
body. The compiler-distributed module certificate serializes both closed facts.
Runtime HIR may use a checked application-result type to settle a recursive
call's first-order result representation before evaluating its body.
Representation facts additionally record the concrete call-site layout of a
residual type expression and of an unambiguous structural product shape. The
substitution walk traverses every matching aggregate component, including the
element of a non-empty Array, and residual argument lowering consumes that same
substitution instead of reopening the type expression. A conflicting observation
invalidates the fact; it never selects one observation by order. Safety owns
coverage decisions and relational proofs. It may instantiate only a summary
derived from the compile-time closure value or a trusted primitive contract; a
binding path or source name is not a safety premise. The current summary
certificate is unary array length plus a literal affine offset and is erased
after the direct-operation proof is constructed. Ownership owns path
consumption, extraction lineage, Store-reuse permission, and closure ownership
contracts. A contract is keyed by defining module revision and lambda-body
identity and contains a parameter-pattern identity, a closed inferred-input
authority tree, a closed produced-result tree, and finite requirements for any
function-valued parameter that receives owned state. A requirement identifies
the callback parameter structurally and records its owned input plus a qualified
direct result or every named result alternative. Applying the enclosing function
substitutes the actual callback's checked contract through that input and
requires the exact recorded result; type equality, specialization, and source
names are not evidence. An unqualified settled Array position begins with affine
Store authority and contributes it to the published input only when the body
consumes or transfers it; linearity remains outside the type lattice. The
compiler-known identity transform of an `assert.reuse` declaration tag forwards
the raw closure's exact contract; it does not recompute one from the decorated
binding. For a recursive function whose checked result is Array, Region, or
Scratch, ownership may seed one provisional produced-result tree from the sole
matching input authority. The completed body must return that exact authority or
complete Region root on every terminating path, or checking reports
`BLOT_RECURSIVE_OWNERSHIP_RESULT`; an arbitrary recursive result is never
upgraded from its runtime type alone. When the produced tree says the result is
one parameter component or its complete Region root, Runtime HIR may reuse the
component's already settled representation for a recursive result; this is
consumption of the structural certificate, not type inference from a name. The
result of a residual `call.direct` is marked from that produced tree after its
runtime value is materialized. At a runtime control-flow join, equal owned Store
successors retain their authority; exclusivity comes from control flow and
agreement from the ownership certificate. The compiler-distributed module
certificate serializes it beside the closure signature and validates every
expression, pattern, span, and region derivation reference against the installed
AST before an importer may substitute an argument through it. Checked-module
certificate schema 10 adds Scratch type nodes to the schema-9 callback
requirements, structural lineage, and inferred input/result trees from schema 8.
It identifies every lineage source and callback leaf by module-local pattern
identity, requiring a complete dynamic extraction partition and exact
callback-result substitution. Reuse assertions travel on evaluated closures and
are discharged only after Runtime HIR exists; they are not authority facts.
Neither certificate recognizes a source binding name. Staging owns compile-time
values and residualization decisions. Specialization owns concrete
representations. A later pass verifies and consumes these facts; it does not
infer them again.

Certificate schema 12 records the strict/deferred calling-convention bit on
every function node. Deferred application suspends the caller expression only
inside Rust specialization. Each demand is checked against residual-CFG
reachability, so exclusive branches may each demand once while sequential paths
remain affine. Known calls emit the argument only on demanding paths, and
Runtime HIR never receives a thunk value. A deferred closure that escapes known
application or reaches ABI closure is an explicit target refusal.

The progressive Runtime-HIR builder state is keyed by the typed-Core node ID,
not by a printed type. Its structural representation key is composed from the
interned type-representation graph, closure identity, and settled compile-time
identities that specialization actually observes. Ownership and safety remain
separate certificates: their compact occurrence IDs are consumed when a node is
committed, then the complete Runtime-HIR graph is validated independently.

An identity is valid only within its source revision. Serializing a fact
requires a closed certificate whose premises name stable serialized identities.
Mutable inference variables and live AST object identities never cross a cache,
worker, or compiler-process boundary.

## 5. Error classes

The result distinguishes three failures:

```text
Diagnostic       source does not satisfy the language judgment
TargetRefusal    requested ABI/Wasm target is unsupported
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

In the Node host, a resident source-graph revision key is the canonical root
identity plus every module's exact portable AST (including source spans),
dependency revision keys, and included file identities and bytes. Equality
permits reuse of the root's checked summary, validated Runtime HIR, and emitted
artifact. Loader-object memoization may additionally reuse a complete root
checking judgment while that loader reports the same revision. It may not reuse
a dependency's mutable inference facts independently: those facts can observe
importer constraints and staging context. Baba and compiler Wasm runtime
instances are process resources, not semantic facts, and may be initialized once
and shared across resident compiler sessions.

A progressive node may be reused only when its Core node identity, exact source
origin, and every consumed certificate identity are unchanged. Equality of
runtime operations with different origins is insufficient. An edit that shifts
an earlier span rebuilds the affected suffix even when the emitted machine
behavior would otherwise be equal.

A content hash establishes identity, not authority. In particular, an untrusted
package cannot justify a checked interface by hashing an interface it supplied
itself. Reusing semantic judgments across a trust boundary requires either a
replayable proof certificate or an attestation rooted in the compiler
distribution. The Rust/Wasm distribution's prelude snapshot uses the latter: its
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

The premises are a release-build obligation over one distribution. The Rust/Wasm
implementation resolves `blot:prelude` to the adjacent snapshot through the
ordinary module loader, then validates the portable AST arena, certificate
schema, closed flat type arena, and all arena references before installing the
memoized result. The Node host installs that adjacent snapshot into the Rust
session. The MessagePack envelope is a transport encoding of those existing
artifacts, not another AST schema. If compile-time specialization needs values
represented by the AST, the compiler evaluates the validated AST once per
session and retains its result; the cached interface never substitutes an
asserted runtime value.

Performance is measured by phase work, not by repository boundaries. Cold, warm,
resident, unchanged-revision, source-only-edit, and semantic-edit timings are
different experiments. [`COST_MODEL.md`](COST_MODEL.md) defines them and the
conditions under which a faster compiler remains the same compiler. The
Node-hosted benchmark compares the high-level graph/session adapter with the
direct Wasm transport in one process. It first proves both routes reached
identical Runtime HIR and ABI artifacts, then reports phase medians, artifact
sizes, and host-overhead ratios. Both routes execute the same compiler.

Rust/Wasm is the only implementation of the semantic judgment. Node/TypeScript
may resolve inputs and present versioned facts, but it may not derive a
competing type, ownership, evaluation, Runtime-HIR, or emission result.

Staging evaluates one module instance as one ordered computation before
selecting any named field from its returned value. A written import occurrence
is one instance: aliasing its value does not re-evaluate it, while a second
written occurrence is distinct. Export selection may duplicate or remove only
work proved pure. It may not replay requests, traps, returns, or divergence for
each runtime field.

`return` initially lowers as a tail computation. Checking records its effect row
separately from effects performed by preceding top-level declarations. An empty
settled result row certifies that the tail has no observable requests, so Core
construction and staging may normalize it to an ordinary returned value. This is
a checked fact, not syntax reconstruction; a non-empty result row stays an
ordered computation.

The current Wasm boundary exposes separate functions for fields of a returned
record and has no shared module-initialization state. A root whose top-level
computation is effectful may therefore expose at most one runtime field. More
than one is a target refusal after successful checking, not a source diagnostic.
Pure roots may expose several fields because selecting them cannot change
observations.

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
| resolve literal `import` and `@include` edges                         | a closed dependency graph               |
| reject cycles and invalid include paths                               | source-oriented diagnostics             |
| retain package-owned relative edges and consumer-owned external edges | relocatable reusable libraries          |
| hash, compress, decode, and validate module capsules                  | a portable lowered AST graph            |
| load source prelude or the compiler-distributed Rust snapshot         | the same validated AST and interface    |
| detect changed sources, includes, capsules, and reverse dependencies  | sound resident invalidation             |

### 9.2 Frontend and elaboration

| Responsibility                                                            | Required result                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| execute Baba's generated lexer plan                                       | deterministic tokens and lexical diagnostics     |
| execute Baba's island parser plan                                         | deterministic compact CST                        |
| reuse an unaffected token prefix after an edit                            | fresh-equivalent incremental frontend output     |
| materialize compact nodes, fields, tokens, and spans                      | a checked CST view                               |
| fold the generated fixed operator table                                   | ordinary binding applications                    |
| build flat AST arenas and validate their references                       | one source representation for later semantics    |
| desugar loops, statement control, guards, elements, and effect sequencing | the small core source language                   |
| assign source origins and compiler-local fresh names                      | stable diagnostics and hygienic control lowering |
| discover imports and includes in lowered expressions                      | complete graph inputs before evaluation          |

### 9.3 Static semantics

| Responsibility                                                                    | Required result                               |
| --------------------------------------------------------------------------------- | --------------------------------------------- |
| construct lexical scopes, `open` frames, recursive groups, and shadowing          | resolved ordinary bindings                    |
| instantiate modules and evaluate compile-time declarations                        | static values and generative identities       |
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

| Responsibility                                                                                | Required result                                       |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| distinguish static values from residual runtime computations                                  | phase-safe erasure                                    |
| reuse compile-time results already demanded by checking                                       | no second semantic derivation                         |
| inline or apply imported module closures under concrete arguments                             | consumer-specific program meaning                     |
| specialize structural calls by concrete shape                                                 | monomorphic runtime operations                        |
| instantiate higher-order representation variables from concrete arguments                     | closed nested closure signatures                      |
| solve positive recursive representation equations by their least fixed point                  | a finite graph with private recursive roots           |
| preserve compiler-local control envelopes while erasing their payload wrappers                | one runtime sum for statement control                 |
| erase scalar refinements without changing their concrete layout                               | equal layouts for refined and open facts              |
| normalize pure integer type predicates before bridging and erase their source functions       | canonical range/union types and no residual predicate |
| erase first-class effect values at explicit sequencing boundaries                             | one checked nullary call                              |
| closure-convert runtime free variables into explicit function parameters                      | lexically minimal residual environments               |
| defunctionalize the finite function set a dynamic branch joins                                | one private choice table per join                     |
| unfold static structural folds around dynamic scalar work                                     | direct runtime projections                            |
| specialize handlers, effect identities, seals, and generated descriptors                      | closed runtime identities                             |
| preserve source evaluation and host-request order                                             | observationally equivalent residual code              |
| choose concrete scalar, product, sum, Store, text, SIMD, and private indirect representations | no open runtime type                                  |
| turn ownership and bounds evidence into permitted target operations                           | checked mutation and eliminated checks                |
| identify runtime exports and their source types                                               | a closed public program boundary                      |

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
| translate runtime operations to a validated direct machine plan                                               | language-independent machine program |
| lower trapping arithmetic, wrapping arithmetic, comparisons, control, memory, host calls, and SIMD            | specified WebAssembly behavior       |
| emit UTF-8 validation, text comparison, integer formatting, relocation, and allocation support when reachable | complete runtime support             |
| encode deterministic WebAssembly and validate it                                                              | final module bytes                   |
| expose the commands assigned to the selected host boundary                                                    | observable compiler tooling          |
| retain reference, conformance, and emitted-Wasm executions                                                    | differential correctness evidence    |
| cache frontend, interfaces, analyses, static values, runtime program, and final artifacts by valid revision   | incremental compilation              |

The inventory is intentionally longer than the pass graph. The pass graph says
which theorems compose; the inventory says how much product behavior exists.
Simplification must remove or combine mechanisms while preserving the required
results. Merely putting the same responsibilities in one file is not a collapse.

## 10. Present implementation shape

This is the ordinary hosted compiler boundary:

```text
source graph resolved by Node
  -> Rust compiler Wasm session
     -> Baba lexer and CPU island plan
     -> CST / AST
     -> checking / comptime / ownership / staging
     -> validated Runtime HIR
     -> ABI closure and Wasm plan
  -> WasmArtifact
```

The host caches final artifacts by exact source-graph revision. The resident
Rust session owns checked interfaces, request-local facts, staged values,
Runtime HIR, and closed programs. A changed module invalidates itself and its
importers inside that session. Updates commit only after the requested phase
succeeds. The Wasm instance is disposed explicitly.

Residual structured values use the settled checked boundary type, not only the
constructor or element observed during staging. This keeps empty Store values,
closed variants, records, and sealed values layout-stable. A staged self-tail
call may become an explicit Runtime-HIR loop back-edge; a settled first-order
non-tail recursive binding becomes a Runtime-HIR function and `call.direct`. An
escaping closure still requires the ordinary closure representation. A direct
call's structural ownership result is replayed onto its materialized value, so
an Array successor remains reusable across separately emitted recursion. Dynamic
`@array.take` and `@array.split` require the same replayed array-index
certificate as direct reads and writes. After that proof boundary they
residualize plain tuples through the same Store and control-flow vocabulary as
prelude folds, with no failure tag and no collection-specific target operation.
Canonical adapters currently admit direct scalar results and the existing
structured ABI policy. Unsupported target policy is a `TargetRefusal`; a failure
after validated Runtime HIR is an `InvariantFailure`. Neither is a source
diagnostic, and neither receives a fabricated source span.

Rust/Wasm is the sole semantic implementation. Semantic authority belongs to
this specification and `LANGUAGE.md`; Node/TypeScript may resolve and present
compiler facts but may not derive a competing judgment.

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

Region element ownership follows this law. The source checker carries
`Region(authority, elements)` and validates consuming replacement and witness
reassociation. Runtime HIR receives only the Store/bounds product and the
authorized read/write occurrence; element trees and rejoin witnesses are proof
facts and are erased. The Rust certificate checker independently reconstructs
the same transfers from the source AST before accepting that residual program.

The reusable ownership fact is the family-tagged partitioned capability defined
in `spec/PARTITIONED_CAPABILITIES.md`, not an array or Slice operation. Array
intervals are the first registered family. Generic ownership code owns family
identity, root identity, conservation, witness lifecycle, and coherence; family
adapters own addressing, footprint composition, runtime representation, and
destructive lowering. No source value may register a family or assert its laws.

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

### 11.5 One language judgment, one implementation

Rust/Wasm derives the semantic judgment. Node/TypeScript is a host and syntax
tooling layer. Conformance compares the Rust evaluator with emitted Wasm and
focused runtime observations; it never asks a second checker to vote on the
language.

## 12. Minimal compiler architecture

The compiler keeps one semantic contract per boundary:

| Boundary  | Host or implementation                                | Contract output                |
| --------- | ----------------------------------------------------- | ------------------------------ |
| graph     | `src/compiler/frontend.ts`                            | resolved sources and includes  |
| frontend  | `compiler/src/frontend.rs` + `source.rs`              | AST                            |
| typecheck | `compiler/src/typecheck.rs`                           | checked facts                  |
| hir       | `compiler/src/hir.rs`                                 | validated Runtime HIR          |
| backend   | `compiler/src/backend.rs`                             | closed program / Wasm artifact |
| session   | `src/compiler/session.ts` + `compiler/src/session.rs` | resident host API              |

Baba remains the syntax authority. Compiler code does not depend on conformance
code; conformance consumes public compiler boundaries.

`Runtime HIR` is the semantic/backend boundary. It contains settled runtime
types and effects, residual operations, concrete representations, and source
origins. It contains no live inference variable, open structural row, or
unresolved effect. Gpupaper may reject unsupported target features, but it may
not infer or change Blot semantics.

The architecture deliberately does not remove Baba, source effects, algebraic
subtyping, ownership, safe arrays, compile-time modules, canonical ABI checks,
or differential testing. It removes Deno and the native Rust toolchain from
ordinary parsing, checking, and compilation.

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
5. **Complete: remove arbitrary user-defined fixity.** One fixed table folds
   operator chains. The old header is recognized only for a targeted migration
   diagnostic and never becomes semantic state.

The first lever is the only language change likely to rival the architectural
collapse. Types-as-values plus imported compile-time dispatch means inference,
evaluation, module caching, and specialization are necessarily mutually
dependent. No data layout makes that dependency disappear.

## 14. Decision experiments

The collapse should be tested by deletion or replacement in this order:

1. **Complete:** `build` and the public `Compiler` route every semantic request
   through the CI-built Rust compiler Wasm. No TypeScript semantic fallback
   remains.
2. **Complete:** constant and residual programs share Runtime HIR and the Rust
   emitter, including structured canonical results.
3. **Complete at the persistence boundary:** one `ClosedProgram` owns Runtime
   HIR and the compiled artifact for a semantic revision. Flattening the
   remaining request-local analysis arenas is a separate internal optimization.
4. **In progress:** checked boundary types and source origins close arrays,
   variants, host grants, and specialized tail recursion without guessing from
   the current staged value. General escaping closure conversion remains a
   separate representation task.
5. **Complete:** one `PublicLayout` owns manifest bytes, capabilities, canonical
   layout, and the data consumed by adapters.
6. **Complete:** the Rust/Wasm compiler owns target planning and binary
   emission; Blot has no duplicate emitter in Node.
7. Replace the package capsule and prelude snapshot with one flat module
   artifact whose optional sections are AST, checked static interface, and
   `ClosedProgram`, all keyed by the same semantic schema.

After each experiment, count concepts deleted as well as milliseconds saved. The
acceptance signal is fewer authoritative representations and fewer complete
semantic traversals with equal observations. A faster path that leaves both old
and new mechanisms in production makes the compiler more complicated and is a
failed simplification experiment.
