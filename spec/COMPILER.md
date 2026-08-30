# Compiler contract

## Status and scope

This document owns the compiler-wide judgment, phase graph, fact ownership,
failure taxonomy, determinism conditions, and validation boundaries. Exact
source and focused semantic rules live in the documents indexed by
[`README.md`](README.md), with cross-document constraints in
[`COHERENCE.md`](COHERENCE.md).

The compiler implements one language judgment. A fast path, cache hit, resident
server, batch scheduler, auxiliary evaluator, or target backend may validate or
memoize that judgment; it cannot define a weaker semantic mode.

## 1. Whole-compiler judgment

Let:

- `Sigma` be compiler schema, generated language plan, primitive catalog, and
  certificate versions;
- `G` be a complete resolved source graph, including import and include inputs;
- `tau` be target and ABI policy;
- `W` be a WebAssembly module;
- `M` be its canonical public manifest; and
- `D` be an ordered diagnostic set.

Write successful compilation as:

```text
Sigma ; tau |- G downarrow Success(W, M)
```

Other classified results are:

```text
Diagnostics(D)
TargetRefusal(reason)
InvariantFailure(reason)
```

`D` contains disjoint diagnostic meanings:

```text
SourceDiagnostic  a source-language premise is false
LimitDiagnostic   a documented deterministic compiler resource bound was reached
```

Only a source diagnostic establishes that a language derivation failed. A limit
diagnostic establishes neither acceptance nor rejection and is not a source
return, request, trap, or divergence.

Successful compilation has no diagnostics. The sidecar and embedded manifest
bytes are identical.

## 2. Input world

A compilation revision includes every input any selected phase may observe:

```text
Revision(G, tau) = hash(
  compiler and certificate schema,
  generated parser and operator plan,
  root and dependency source bytes,
  resolved import occurrence graph,
  included bytes and transforms,
  primitive catalog,
  package/capsule policy,
  target and ABI policy
)
```

A phase-specific key may omit a component only after proving the phase cannot
observe it. Source identity, module-definition identity, import occurrence,
module instance, effect atom, seal, Store root, and artifact revision remain
distinct.

Ambient current directory, process environment, network state, clock, random
state, or undeclared host capability is not a compiler input unless a future
language revision makes it explicit and revisioned.

The Node host may retain one validated immutable `WebAssembly.Module` for the
bundled compiler distribution per process. Each `Compiler` still instantiates
fresh Wasm state and creates a fresh semantic session; compile-time
environments, module revisions, generative identities, diagnostics, and
artifacts are never shared through the code cache. A custom compiler/snapshot
pair does not enter the bundled cache. On that production load path, the host
may check the Wasm header, authenticated digest, manifest, ABI, and prelude
identity concurrently with Wasm compilation. Both must succeed before
instantiation. Wasm compilation performs structural validation once; the host
does not parse the complete binary once with `WebAssembly.validate` and
immediately again with `WebAssembly.compile`. Artifact download verification
remains independently usable and therefore performs standalone structural
validation.

The Node-to-compiler transport is compiler-host ABI 5. Paths are registered once
as UTF-8 and receive stable session-local module identities. A graph update is a
length-delimited binary frame containing changed UTF-8 source or compact AST
bytes, direct edges, includes, and removals. A trusted compiler-distributed
snapshot uses a separate explicitly named installation operation and is never a
generic graph-delta payload. The decoder validates the complete frame before
mutation, rejects unknown identities and trailing bytes, and reconstructs UTF-16
source offsets during decoding. Compact success summaries avoid JSON on the
check hot path; diagnostic and requested analysis payloads retain their
classified content. ABI 5 prepares development-program artifacts under a
transaction identity, exposes indexed Wasm and manifest bytes until the next
transport call, and commits the resident artifact cache only through the
matching commit operation. The graph-delta frame remains schema 3.

[`compiler/protocol.json`](../compiler/protocol.json) is the version authority
for the compiler-host ABI, checked-module certificate, module snapshot, value
capsule, and Runtime HIR. The module-snapshot and value-capsule versions
describe nested compiler artifacts. They change independently from the public
ABI, compiler-host ABI, certificate, and Runtime-HIR versions unless a
representation change crosses one of those separate boundaries.

## 3. Pass graph

The production pass graph is:

```text
source bytes
  -> tokens and compact CST
  -> resolved surface AST
  -> value/computation Core
  -> demanded Core
  -> ordinary type-and-effect checking
  -> coverage and relationship checking
  -> ownership and reuse checking
  -> compile-time evaluation and residualization
  -> representation-closing specialization
  -> validated Runtime HIR
  -> public-layout construction
  -> WebAssembly and manifest
```

QCore is a non-authoritative shadow artifact beside this graph:

```text
checked-module certificate + matching AST, or sealed boundary + source origin
  -> QCore v3 shadow projection
  -> shadow-only structural validation
  -> ValidatedQModule
```

No production pass invokes or consumes that projection. Focused tests use it to
show that the existing closed structural type/effect certificate has a lossless
QCore representation with real source origins. Its kernel checks the schema,
arena references, scopes, canonical labels and effect rows, structural ranges,
and interval grades specified in [`QCORE.md`](QCORE.md). The separate pure
typing shadow admits none of the projected structural forms. Validation proves
no typing fact and cannot replace, weaken, or authorize any arrow in the
production graph.

Every pass has:

- a typed input artifact;
- a typed output artifact;
- an explicit set of facts it may read;
- a complete set of facts it produces;
- classified failures;
- deterministic identity allocation;
- a validator or downstream replay point where appropriate; and
- a local simulation or adequacy obligation.

A later pass may consume or replay an earlier fact. It may not infer a
replacement from printed names, source spelling, target layout, or optimization
artifacts.

## 4. Frontend facts

The frontend produces:

```text
TokenId
CompactNodeId
SourceSpan
ResolvedBindingId
ControlTargetId
ImportOccurrenceId
SourceOrigin
```

`grammar.baba` is the only parse authority. Operator grouping uses the generated
fixed language plan; source modules cannot create a fixity environment. Layout
continues expressions but creates a statement value only through `do:` or
through a module body. A surrounding `const` declaration determines that its
initializer, including a `do:` block, must resolve at compile time.

Surface elaboration is hygienic and preserves source origins. Every function
application becomes a Core computation; an empty effect row does not create a
second pure-application artifact.

An incremental frontend result must equal a fresh result, including diagnostics,
spans, compact edges, and resolved identities.

## 5. Demand facts

After resolution and surface elaboration, the compiler builds the lexical
binding dependency graph and computes:

```text
live(block, result) = L
```

Dead pure declarations are absent from the source program being checked. Forced
declarations and every declaration reachable from the result remain in source
order.

The demand artifact records:

- live binding identities;
- resolved dependency edges;
- forced declaration reasons; and
- source origins for erased declarations needed by diagnostics or tooling.

Demand is fixed before optimization. Ownership consumes the demanded artifact. A
consuming action inside an erased declaration cannot satisfy a linear use
obligation.

## 6. Ordinary checking

Ordinary checking produces:

```text
ClosedOrBoundedType
EffectRow
TypedCoercion
CompileTimeIdentity
TypedCoreOrigin
```

The open rank-1 algebraic core uses lower/upper-bound inference. Rank-N
subsumption, checked reflection, closed ground operations, predicate
normalization, relationships, ownership, and representation closure remain
separate checked boundaries.

Every application is typed as a computation. A source pure position may bind its
result only after the row settles empty. Effect emptiness does not establish
termination or absence of traps.

A missing ordinary premise yields a source diagnostic. An internal mutable
graph, worklist, or unconstrained inference variable never crosses a closed
interface or cache boundary.

Representation-driven closure inference records compiler-authoritative
specialization keys, call sites, and deterministic soft/hard budgets. The soft
budget is an editor hint. Exceeding the hard budget is the source diagnostic
`BLOT_SPECIALIZATION_LIMIT`, because the selected source program requires more
compiler-generated representations than the documented bounded implementation
admits; it is not reported as memory exhaustion. Each fact offers remediation
through a narrower parameter, public signature, runtime parameter, or explicit
stable representation.

Type, ownership, specialization, and target explanations retain compact
provenance during checking and materialize ordered explanations only on request.
That provenance is observational: it does not enter semantic equality, cache
keys, certificates, or emitted artifacts.

Editor simplification facts are a separate finite certificate catalog. The
checker may certify an expression as exact integer equality or as a
short-circuit conjunction only from the resolved compile-time value, checked
types, and demand behavior; a callee's printed name is never evidence. These
facts are stored by module-local expression identity in the checked-module
certificate so aliases, resident caches, and snapshot installation preserve the
same answer. They do not enter the sealed public boundary or emitted artifact.
The host may render a source rewrite from a fact and recheck that rewrite, but
it must not derive an equivalence fact itself.

Editor readability facts form another finite certificate catalog. They expose
semantic premises for source-style diagnostics without adding those diagnostics
to checking: whether a `use` operand was already a direct computation, whether
an expression denotes the polymorphic empty array, whether a lexical shadow
preserves its stable type, whether an explicit shape reconstructs one exact
ordered record, and which names a pure `open` actually supplied. The facts are
stored in the checked-module certificate by module-local expression identity.
Different fact kinds may overlap at one expression, but one certificate has at
most one payload for each `(kind, expression)` pair. The host may combine a fact
with syntax-local premises and recheck a proposed edit; it must not infer these
semantic premises itself. Readability facts enter neither Runtime HIR nor an
emitted artifact.

## 7. Safety checking

### 7.1 Coverage

Coverage produces an exhaustiveness result for every closed match, with complete
pattern-column and guard evidence. An accepted match is exhaustive or has an
irrefutable arm. A missing arm is a source diagnostic; it is never deferred to a
Runtime-HIR stuck state.

### 7.2 Relationships

Relationship checking carries propositions keyed by stable immutable-value
identities. A proof-required operation produces a certificate containing:

- source revision;
- saturated operation identity;
- exact premise value identities;
- normalized proposition; and
- solver/checker schema.

A validator reconstructs the proposition and rejects copied, stale, foreign, or
identity-mismatched evidence.

### 7.3 Ownership

Ownership checking carries path-indexed modes:

```text
unrestricted
borrowed
affine
linear
```

It produces closure summaries, branch states, consumed-path facts, partition
witness lineage, and destructive-reuse certificates.

For a symbolic Array parameter, element shareability and backing-Store access
are separate certificate fields. Type specialization may refine only element
shareability. Destructive operations and calls propagate `Unique` Store access;
a branch join uses `Unique` when any continuing alternative requires it.

The checker enforces mode-specific rules: affine discard is permitted; linear
paths require one consuming action on every terminating exit. A consuming
operation is not assumed to run a domain-specific finalizer unless its own
contract says so.

## 8. Compile-time evaluation

Compile-time evaluation runs only with compile-time bindings and explicit
revisioned inputs. Source and host effects are unavailable.

Checked bridges interpret compile-time values as types, effect descriptors,
layouts, declaration tags, or reflection data. Operator fixity is not a staged
value; it comes from the generated language plan.

Identity policy is explicit:

- ordinary source effects are generative under complete module-instance,
  declaration, and compile-time-scope identity;
- seals are applicative in public name and canonical invariant carrier; and
- administrative compiler identities are hidden only when the semantic relation
  says so.

A semantic phase violation or failed required bridge is a source diagnostic. A
documented fuel, memory, stack, or expansion bound is a limit diagnostic.

## 9. Staging and specialization

Staging erases compile-time and proof-only values after consuming them into
residual code or checked metadata. Residual code is closed over compile-time
bindings.

Specialization closes:

- residual quantified uses;
- record and variant representations;
- effect and handler representations;
- closure environments;
- branch joins;
- deferred-call choices;
- Store element layouts; and
- public type metadata.

It inserts explicit representation coercions and attaches replayed ownership
permission to destructive operations.

A closed production-supported internal program that remains representation-open
at Runtime-HIR construction exposes an invariant failure. An explicitly
unsupported public type or experimental target feature may yield target refusal
at its stated policy boundary.

## 10. Runtime-HIR production and validation

Runtime HIR is constructed only after representation closure. The producer emits
closed operations, values, control flow, Store lineage, host requests with
normalized input/result ownership, traps, and public metadata.

Schema 6 adds an integer `switch` terminator. The producer creates every arm
block before evaluating its residual body, settles survivors against the checked
result representation, and emits parameter-free switch edges followed by
ordinary branches into a shared join. Validators and emitters consume this
terminator directly rather than reconstructing a case tree from source.

The validator independently checks:

1. structural reference validity;
2. control-flow and branch-argument agreement;
3. closed operation and call representations;
4. exact relationship-certificate replay;
5. exact ownership and reuse permission;
6. Store/root and capability-family lineage;
7. capability operation ownership matches the exact closed input/result types;
8. absence of compile-time and proof-only values;
9. target-policy admission; and
10. complete public-layout inputs.

Producer success followed by validator failure is an invariant failure. The
validator does not generate a new source diagnostic by reconstructing source
syntax.

## 11. Public layout and ABI

Public-layout construction is partial over closed checked types:

```text
publicLayout(tau, A, ownership)
  -> PublicLayout
   | TargetRefusal
```

It returns target refusal for types or features outside the declared policy. It
must not accept a boundary whose required malformed-input validation is
unimplemented.

`RUNTIME.md` owns the semantic source/caller relation. `docs/abi.md` owns exact
ABI 2 bytes and caller ownership.

For every admitted type, lifting validates before constructing a source value,
and valid values round-trip through lowering and lifting up to the
representation relation. Seal names are manifest/conformance facts; equal raw
carrier bytes do not dynamically enforce source nominality.

Private Runtime-HIR roots, live capabilities, proof witnesses, unsupported
closures, and other no-layout values are refused before emission. Reaching the
emitter with such a public boundary is an invariant failure.

## 12. Emission

The emitter accepts only validated Runtime HIR and public layout. It produces:

- a WebAssembly module accepted by the Core validator;
- the canonical manifest bytes;
- optional deterministic side products explicitly named by the build contract;
  and
- no untracked source-semantic fact.

A target trap is permitted only when related to a specified source trap or a
versioned malformed-boundary/ownership trap. A defensive internal check may
remain only when related valid states cannot reach it; reaching one is an
invariant failure.

Emission uses the overflow, bounds, NaN, order, ownership, and host-call
behavior selected by the validated Runtime-HIR operation rather than incidental
target instruction behavior.

An emission pass that reparses encoded function bodies for metadata must admit
every WebAssembly feature used by those bodies. Metadata inspection cannot
refuse an operator that the emitter selected for the validated module.

The Runtime-HIR producer records each schema-6 float-shuffle selector as a
dominating `integer-32` constant operand. The emitter treats a missing,
non-constant, or out-of-range selector as an invariant failure rather than
performing target-side type inference.

## 13. Failure classes

### 13.1 SourceDiagnostic

A source diagnostic means a source-language premise is false, for example:

- parse or resolution failure;
- forbidden phase dependency;
- failed type, effect, coverage, relationship, or ownership premise;
- unsupported source operation under the language profile; or
- required compile-time value that evaluates to the wrong semantic kind.

It may be cached only under the exact observed revision and diagnostic schema.

### 13.2 LimitDiagnostic

A limit diagnostic means a documented deterministic compiler resource bound was
reached, for example `BLOT_EVALUATION_LIMIT`.

It establishes no source rejection and is not part of source execution.
Increasing the bound may let the same source revision compile successfully.
Limit diagnostics are deterministic for the fixed configured bounds and remain
separate from target refusal.

### 13.3 TargetRefusal

Target refusal means a checked program lies outside the selected target or ABI
policy. It is permitted only at an explicit policy boundary, such as a public
vector type refused by ABI 2 or an experimental target feature not enabled for
production.

It cannot hide an unresolved production-supported internal representation,
missing certificate, accepted-but-unvalidated public input, or private object
that leaked past specialization.

### 13.4 InvariantFailure

An invariant failure means a compiler contract previously claimed to hold has
been violated, including:

- producer/validator disagreement;
- missing fact after successful checking;
- unstable semantic identity;
- unresolved supported representation;
- target-only visible outcome;
- accepted public layout without required validation; or
- manifest and emitted adapter disagreement.

Invariant failure is never downgraded to a source diagnostic.

## 14. Determinism

For fixed complete revision, target policy, documented limits, and compiler
schema, the compiler result is deterministic:

```text
compile(input) = result_1
compile(input) = result_2
--------------------------------
result_1 = result_2
```

Equality includes ordered diagnostics, closed interfaces, certificates,
Runtime-HIR artifacts, manifest bytes, and WebAssembly bytes modulo only the
explicitly hidden identity relation.

Parallel work may run independent ready nodes concurrently. Commit order follows
a canonical module order, diagnostic order follows source order, and no mutable
inference graph crosses a worker boundary.

## 15. Incremental and cached compilation

Incremental compilation is memoization of fresh compilation. For phase `P`:

```text
key_P(x) = key_P(x')    validate(cached(P(x')), x)
-------------------------------------------------
P(x) = cached(P(x'))
```

A cache key contains every input observed by the phase. Reuse cannot merge
separate import occurrences, module instances, generative effect atoms, Store
roots, ownership lineages, or source revisions.

Closed interface decoding validates scopes and freshens quantified identities.
Mutable bounds, worklists, AST object addresses, and fact sinks do not cross the
cache boundary. A content hash proves transport integrity, not semantic
correctness of a package-controlled claimed interface.

The trusted checked-module snapshot may additionally carry a deterministic
compile-time environment graph. Its schema is independent of the
checked-interface schema; decoding validates environment references and parent
acyclicity, remaps module-local closure provenance to the installed path,
requires every closure's parameter, body, and evaluation mode to match one
lambda in the installed AST, and obtains each closure signature on demand from
the checked certificate's validated flat arena. The resident context memoizes
the reified signature under its exact module and closure-body identity. Freshly
checked modules publish the same resolver over their closed residual signatures,
so eager attachment and later residual evaluation observe one contract. Because
installable snapshots are dependency-free, an external module reference is
invalid. The bundled host reaches this decoder only after validating the
snapshot digest against the compiler artifact manifest. Supplying a custom
compiler/snapshot pair explicitly makes that distribution the caller's trust
boundary; neither registry capsules nor ordinary graph deltas can invoke this
path. Unsupported process-local or generative values make the environment
ineligible rather than weakening the cache boundary. A captured closure retains
its complete application and module-instance provenance. Encoding accepts only
provenance rooted in the snapshot module's current semantic revision; decoding
validates every source expression and declaration reference and remaps that
revision to the installed module. An external or stale revision makes the
environment ineligible. The optimized interface path additionally requires the
certificate to contain no generative effect label or opaque effect identity and
the exact snapshot AST to contain no ordinary or host effect constructor.
Otherwise installation validates the supplied certificate but checks the
snapshot AST in isolated resident staging, so generative identities and effect
metadata are reconstructed in the receiving session. Nullary modules are then
evaluated in staging; parameterized modules remain unevaluated until an import
supplies their argument.

The snapshot boundary scans raw MessagePack iteratively before recursive serde
deserialization. It admits at most 32 MiB of bytes, 128 nested levels, 1,048,576
structural nodes, and 64 MiB of estimated allocation using protocol-fixed
weights that agree on native and Wasm hosts. It accepts exactly one complete
root, checks all marker and collection lengths with overflow-safe arithmetic,
and refuses trailing values and the reserved marker. After decoding, the
portable AST and checked type certificate receive a separate protocol-fixed
logical graph preflight. Every AST arena node and flat-type root-to-leaf path is
limited to 128 reference edges, and expanding duplicate references may visit at
most 1,048,576 nodes. The AST also sums that expansion across its parameter,
declaration, and result roots; the certificate sums its result, effects,
parameter, expression-type, and closure-signature roots. Snapshot and portable-
AST export run the same admission, so the compiler cannot publish an artifact
its installer refuses. The decoded schema-4 value capsule reapplies the logical
depth, node, and allocation budget before recursive value, environment,
effect-scope, or application work; its flat identity graphs are then checked
iteratively for missing edges, cycles, and their separate bounds: a 1,024-edge
environment-reference path or a 128-edge effect-scope path. Export runs the same
raw MessagePack preflight after serialization. If only the optional environment
fails, export serializes and preflights the capsule-less AST and certificate
once more. A trusted input that fails any of these checks is a corrupt or
unacceptable distribution and snapshot installation remains transactional. A
source-derived environment that exceeds the capsule budget merely makes the
optional compile-time environment cache ineligible: the AST and certificate
remain complete and replay supplies the environment without a source diagnostic.

The validated environment may also serve as a revision-keyed module-result
template. A nullary import decodes it over that written occurrence's complete
module-instance and effect-scope prefixes and evaluates only the result
expression. Reconstruction requires the existing provenance depth/node admission
and a deterministic allocation estimate no greater than 64 MiB. That estimate
includes the capsule's base allocation, the caller module-instance prefix copied
per stored closure and identity key, and the caller effect-scope prefix copied
per non-empty stored scope. On a cache miss, the structural fold produces a
short-lived reconstruction-admission fact that borrows that exact capsule and
records that its caller-prefix allocation fits. Only that fact may enter the
decoder after structural validation without repeating the fold; it cannot be
stored, paired with another capsule, or outlive the borrowed capsule. The decode
continuation still validates environment and effect-scope graphs, closure and
recursive-group provenance, and every referenced source identity before
reconstruction. Excessive provenance or caller-prefix allocation replays
declarations without decoding the optional template. Failure to validate the
installed capsule itself remains an invariant failure rather than replay. The
fact does not participate in cache identity. The resulting closures are
occurrence-local; the template is never a directly shared closure-bearing module
result.

A cache hit and fresh compilation produce equivalent results; only work changes.

### 15.1 Development-unit reuse

Development compilation begins with the same checked, staged, specialized, and
validated program as a fresh production compilation. A versioned project
manifest supplies a named entry unit and a one-to-one map from unit names to
reachable module roots. It does not change resolution or introduce a second
module system.

After representation-closing specialization, the development splitter assigns
each demanded residual function to the configured root containing its stable
source definition. A direct call between different assignments becomes a
`RuntimeLink`; local calls remain direct. A closure creation whose definition
belongs to another unit is refused because it would move a function value over
the boundary. Each link carries one closed first-order signature derived from
the checker facts. The splitter does not infer a replacement signature from
backend layout.

For development unit `U`, the compiler deterministically serializes the complete
normalized Runtime-HIR module for `U`, including link signatures, link targets,
capabilities, and exports within one resident compiler and target-policy
session. The implementation key reported to the host is a fixed-size digest of
that serialization, but the resident artifact cache retains the serialization
and requires byte-for-byte equality in addition to an equal digest and
configured root identity. A digest collision therefore cannot authorize resident
artifact-cache reuse. The interface key is the canonical ABI manifest bytes.
Consequently, an implementation-only provider edit can reuse its consumers,
while a changed link signature changes and rebuilds every direct consumer.
Reverse invalidation continues only after publication of a changed
checked-module boundary.

The development compiler returns every current unit identity plus whether its
emitted artifact was reused. A reused-unit response contains its capabilities
and identities but no duplicate Wasm or manifest bytes; the corresponding ABI
byte accessors return null pointers and zero lengths. The unchanged
`artifactSource` discriminator tells the host to retain its previous artifact.
Only a `unit-cache` response proves equality with the resident artifact's full
Runtime-HIR serialization. A `compiled` response is changed even if its reported
fixed-size key collides with the prior key. The host also retains a SHA-256 of
the emitted Wasm, checks that digest before activation, and includes it in the
development revision. The interface identity commits the canonical ABI manifest
and therefore every development link. Activation rederives the canonical edge
set from the final unit manifests, requires every provider to be present, and
requires exact agreement with the reported edges. Each link must resolve to
exactly one provider runtime export with the same closed ABI signature before a
host import callback or instantiation runs. The provider's compiled Wasm module
must contain function exports under that runtime export name and any post-return
name declared by the manifest. Wasm reflection establishes only the export name
and kind; the canonical manifest remains authoritative for the closed logical
signature. The revision does not hash a second edge encoding. It parses every
changed and retained unit identity before activation. Host artifacts are staged
separately and replace the resident artifact set only after every unit has been
validated and the development revision digest has been computed, so a failure
leaves the prior set intact. It must not publish a partial build after any
checking, splitting, validation, or emission failure. Release compilation does
not consume these unit artifacts and retains the whole-program cache and
artifact contract.

Rust artifact reuse follows a two-phase protocol. Preparation reads only the
committed artifact map and stages compiled replacements with the exact active
cache keys under a fresh transaction identity. Starting another preparation
abandons that candidate, including when the later preparation fails. The host
copies and validates every returned byte range, hashes the manifest and Wasm,
and computes the canonical revision before synchronously committing the current
identity. Commit atomically applies replacements and exact-key pruning. A stale,
duplicate, or absent identity is an invariant failure and cannot mutate the
committed map. The host replaces its private identity map only after Rust
accepts the commit. Public compiled arrays and capabilities do not alias either
private map; cache-hit responses remain byte-free.

The reference development benchmark is a 5 MiB, 20-unit project whose entry
calls every unit. Catalog source is distributed across 18 unchanged content
units, while the edited gameplay provider stays small. The edit preserves its
interface, notifies the resident graph of the known path change, and performs 20
warm rebuilds. Exactly that provider must change. On the project reference
machine, wall-clock p95 from file edit through committed runtime activation must
remain below 100 ms. Maximum resident-memory growth after initial activation
must remain below 128 MiB across the 20 edits, so the benchmark rejects a reload
path that retains one compiler working set per revision. This benchmark is a
named development-mode boundary; it does not claim the same latency when an edit
changes the demanded graph or a public unit interface.

## 16. Artifact production

Generated parser plans, prelude snapshots, certificate schemas, compiler Wasm,
and package capsules are source-derived artifacts with explicit manifests.

A tracked or distributed artifact is accepted only after validating:

- schema and compiler version;
- exact source/dependency revision;
- language-plan and primitive-catalog identity;
- internal reference ranges and closed scopes;
- target and ABI policy; and
- any cheaper proof certificate the artifact claims to carry.

A stale artifact is regenerated or rejected according to its distribution
contract. It does not silently become source authority.

The packaged compiler's stack, memory, and evaluator limits are implementation
budgets. They do not alter emitted-program memory or prove negative source
judgments when exhausted. In particular, exhausting the optional value-capsule
publication budget omits that cache rather than producing a limit diagnostic;
exceeding the trusted snapshot boundary is an artifact/distribution refusal.

## 17. Pass correctness

Each pass publishes a local relation and progress-sensitive adequacy package as
specified by [`CORRECTNESS.md`](CORRECTNESS.md). Weak forward simulation alone
is insufficient.

The composed theorem preserves and reflects:

```text
Return
Host request/response protocol
Specified source trap
Specified malformed-boundary trap
Divergence
```

for closed accepted programs, admitted public layouts, and conforming related
hosts. Target-only finite outcomes and infinite administrative stuttering are
excluded.

## 18. Validation and test obligations

Production acceptance requires layered evidence:

1. parser and incremental-frontend equivalence;
2. hygiene and explicit-control elaboration;
3. demand erasure and empty-row application regressions;
4. type, effect, coverage, relationship, and ownership checking;
5. certificate mutation and replay rejection;
6. effect/module/seal identity tests;
7. capability-family law and stale-witness tests;
8. staging, specialization, and Runtime-HIR validation;
9. source/Rust/Wasm differential observations;
10. ABI valid round trips and malformed-input traps;
11. deterministic artifact and manifest regeneration; and
12. formal checks for the stable Core fragment with no admitted declarations.

A passing example is evidence, not a replacement for the named theorem or
validator.

## 19. Trusted computing base

The trusted computing base includes the parser plan and implementation,
resolution and elaboration, declarative rule implementations or their
validators, certificate checkers, Runtime-HIR validator, public-layout builder,
emitter, manifest encoder, and the WebAssembly engine assumptions used by the
theorem.

Trust is reduced when:

- a small validator reconstructs producer premises;
- generated artifacts are tied to exact source revisions;
- semantic identity classes are explicit;
- unsupported boundaries refuse before emission; and
- production artifacts are connected to mechanized models by a checked
  translation.

A theorem about a seed calculus does not automatically cover the production
frontend, module system, ownership checker, specialization, Runtime HIR, or ABI.
