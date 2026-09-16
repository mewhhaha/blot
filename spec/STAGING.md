# Staging and specialization

## Status and scope

[`LANGUAGE.md`](../LANGUAGE.md), subject to [`COHERENCE.md`](COHERENCE.md),
defines which source expressions are required to resolve at compile time. This
document owns compile-time evaluation, phase-erasure, specialization, and
representation-closure obligations.

Staging is not an optimizer that may guess whether an expression is convenient
to evaluate. Required compile-time evaluation is part of checking; optional
partial evaluation must preserve the same residual source meaning.

## 1. Phase judgments

Compile-time availability and run-time typing are separate judgments:

```text
Delta ; I |-ct e downarrow w ; I'
Gamma |-rt c : A ! epsilon
```

`Delta` contains only compile-time-available bindings. `I` is the
compiler-controlled identity and explicit-input world. It includes the source
revision, resolved module-instance stack, included byte identities, compiler
schema, primitive catalog, and other inputs that the evaluated expression may
observe.

A run-time binding cannot occur free in a compile-time type, effect descriptor,
layout, declaration tag, reflection decision, specialization choice, or public
ABI shape.

A requirement unavailable while a closure is generic preserves the subject's
inferred type and remains an obligation at specialization. This applies to
generated and imported methods even when their ordinary result already has a
structural type. A requirement failure inside a specialized body retains the
defining module as the origin of its source span.

Local signatures follow the same obligation discipline when a declared generic
binding has no compile-time value yet. Deferral requires evidence of that
binding in the type environment; an undeclared name is a source error. A
callback-bearing argument retains any known compile-time argument value during
contextual specialization, including type values supplied beside the callback.
Neither deferral nor contextual inference may skip a concrete requirement on an
unused constructed result. These observations do not promote runtime bindings
into compile-time scope.

## 2. Compile-time authority

When a checked type or branch join requests a closed variant whose constructor
names and payload representations already exist, staging reuses that sum
representation regardless of the type value's enumeration order. It keeps the
existing runtime discriminants. Manufacturing another case order would insert
identity conversions after recursive calls and destroy tail position; arrays
would also acquire incompatible element representations for equal checked
variants. Constructor tables that explicitly define discriminants retain their
own order. This reuse neither adds cases nor narrows payloads.

Compile-time evaluation has no ambient host authority. It may observe only:

- compile-time bindings in `Delta`;
- dependency-resolved module inputs;
- explicitly included bytes and their declared transform;
- deterministic compiler primitives admitted by the staging contract; and
- compiler-owned identity allocation under `I`.

Source effects and public host capabilities are unavailable. An import or
include is not an ambient filesystem read: dependency resolution supplies an
explicit revisioned input before evaluation begins.

Operator spelling and precedence are not staged values. They are collected from
the source syntax prelude and the module's bounded fixity header before
elaboration.

The source checker validates a rebinding's lexical lineage and stable type
before liveness selects declarations to evaluate. A `Shadow` declaration
consumes its right-hand side and introduces the next binding; it does not demand
the previous value merely to repeat a scope check. Earlier closures retain their
captured binding, and their free-name dependencies keep any required initializer
live.

## 3. Checked bridges

A compile-time value acquires semantic authority only through the bridge owned
by its use site:

```text
bridgeType   : CTValue -> Result<CoreType, SourceDiagnostic>
bridgeEffect : CTValue -> Result<EffectDescriptor, SourceDiagnostic>
bridgeLayout : CTValue -> Result<LayoutDescriptor, SourceDiagnostic>
bridgeTag    : CTValue -> Result<DeclarationTag, SourceDiagnostic>
```

The bridges are partial. A closure that can compute a type is not itself a type;
it must be applied at compile time. A record that resembles an effect descriptor
has no effect identity until `bridgeEffect` validates it. A layout value cannot
smuggle a run-time dependency or private target pointer into public metadata.

A decoder may return a concrete value with a widened sound type:

```text
(w, A, proof that w inhabits A)
```

This is checked evidence, not an unchecked type annotation and not a second
run-time value.

## 4. Determinism and limits

For fixed `Delta`, `I`, compiler schema, and primitive catalog, successful
compile-time evaluation is deterministic up to alpha-renaming of identities that
are explicitly hidden by the result relation.

A required compile-time computation may diverge in the source semantics. The
implementation may stop first at a documented deterministic fuel, stack, memory,
or expansion bound. Such exhaustion is a `LimitDiagnostic`, including
`BLOT_EVALUATION_LIMIT`:

- it is not a source value;
- it is not a source trap or divergent execution;
- it proves neither acceptance nor rejection; and
- raising the bound may let the same source revision finish without changing
  language meaning.

A semantic bridge failure, forbidden phase dependency, or effectful compile-time
expression is instead a `SourceDiagnostic`.

Optional speculative evaluation has a weaker contract. Failure to evaluate an
otherwise residual empty-row expression does not authorize erasure; the
expression remains residual unless the language requires compile-time
resolution.

Finite compile-time unions are flattened, retain the first semantic occurrence
of each member, and compare as sets. The evaluator may keep an indexed
persistent member representation, but an index collision must fall back to exact
type-value equality and extending an aliased union must not mutate the alias.
Signature substitution requires evidence for a constructor's entire payload. An
unknown runtime child refuses that conversion; it cannot turn a populated
constructor into a payload-free one. Collapsing a one-member union to its
constructor preserves the constructor's payload representation. Ordinary
constructor-returning helpers remain staged, as union-returning helpers do, so a
known iterator alternative does not acquire runtime sum dispatch solely through
normalization.

Nonrecursive helpers performing source-handled effects also remain in the
caller's staging context: a handler may supply values from that caller's frame,
which are not lexical captures of the helper. A separate runtime function cannot
refer to those values without an explicit captured-parameter relation.

Store update selection uses the lowered argument's reuse evidence. Lowering a
known empty array creates a fresh reusable Store even when the staged argument
was not already a runtime value; a borrowed or shared runtime Store retains its
persistent update policy.

Within one staging execution, a successful closure call may reuse a prior result
only when its settled arrow is monomorphic and has a closed empty effect row,
the call is not residual, and both argument and result are closed first-order
values. The key contains the closure's exact creation environment,
module-instance stack, effect scope, body identity, and a structural argument
value. Functions, effects, operations, capabilities, Regions, Scratch values,
continuations, residual values, open effects, and type variables are not cache
keys or cached results. Failures are not cached. The bounded cache is local to
that execution and therefore cannot outlive a revision or substitute one module
occurrence for another. This changes evaluation work only; the exported runtime
body retains the source algorithm.

A returned source closure receives the closed result signature recorded at its
call site in preference to an unspecialized codomain. A source codomain is
substituted in the completed call's lexical environment before it is attached to
returned values, including records containing closures. Its effects remain those
established by checking, including when the closure captures other computations.
A generic representation signature that omits those effects cannot certify
purity for call-result caching.

Memo-key admission visits at most 256 value nodes and admits at most 4,096
variable-size payload bytes per argument or result. The byte budget includes
UTF-8 Text and field or constructor names, integer magnitude bytes, and integer
vector or mask lane storage. Fixed-size scalar payloads are bounded by the node
budget. Admission checks each size before copying or descending into that
payload; an oversized value skips memoization and still evaluates normally.
Admitted keys retain structural value equality, including equal Text held in
different allocations. Immutable evaluator Text storage is shared when values
are cloned; this storage choice does not change its content, public encoding, or
semantic identity.

## 5. Generative and applicative identities

### 5.1 Ordinary effects

Source effects created by `@effect` are generative. Evaluating a declaration
allocates under:

```text
(module instance, declaration node, compile-time scope, signature)
```

Administrative re-evaluation of the same recorded occurrence recovers the same
atom. Evaluation under another module-instance stack mints a distinct atom even
when the operation descriptors are structurally equal.

The compile-time scope component is the ordered stack of revision-qualified
source application identities, including each callee's recorded creation scope.
Compiler-owned closure applications carry a typed sub-occurrence rooted in the
source expression, declaration, effect request, or export parameter that owns
them. Repeated evaluation of one stack is stable; a second written call or an
additional recursive frame is distinct. Signature equality is exact semantic
type-value equality, including alpha-equivalence and referenced effect atoms;
neither displayed values nor partial hashes are identity evidence.

A resident nullary module result may replace administrative re-evaluation only
when its checked effect row is empty, its closed result type exposes no ordinary
or host effect identity, and the actual value is recursively independent of its
producing module instance. In particular, a closure can invoke a caller-supplied
effect constructor, so an effect-free result type alone cannot justify sharing
that closure. Values containing closures, deferred environments, function
choices, effects, operations, Regions, continuations, or residual runtime values
are evaluated under each written module-instance occurrence as above. An
authenticated snapshot may avoid replaying declarations by decoding its
validated environment as a template over the current occurrence's complete
module-instance and compile-time scope stacks. This is per-occurrence
instantiation, not resident-result sharing.

A reusable cache entry containing an ordinary effect is valid only when the
complete owning instance identity and revision are preserved. A module path or
declaration spelling alone is insufficient.

`@effect.shared` is applicative in a nonempty text key and the complete
normalized operation contract, including exact alpha-equivalent signatures,
ownership, suspension, and referenced effect atoms. Its identity excludes the
import occurrence, source revision, and local binding name. It remains a source
effect handled by the normal effect machinery; it supplies neither shared state
nor host authority.

The resident interner records every live occurrence of a shared contract.
Invalidation removes occurrence provenance and retires an atom only when no
occurrence remains. Removing one declaring module must retain another module's
declaration of that atom. Snapshot staging clones this table transactionally;
committing a snapshot publishes the staged table with the corresponding effect
values. Shared effects and their constructors remain subject to the existing
conservative effect-capsule admission checks and are reconstructed in the
consumer's resident interner.

### 5.2 Seals

Seals are applicative rather than generative. Their identity is:

```text
(public name, canonical closed invariant carrier)
```

Reconstructing equal inputs reconstructs the same seal across evaluations and
revisions. Cache identity therefore retains the normalized public name and
canonical carrier; it does not substitute a declaration occurrence or fresh
atom.

### 5.3 Other compile-time identities

Every identity-producing primitive states whether it is:

- generative under a complete semantic occurrence;
- applicative in canonical input values; or
- merely an administrative compiler identity hidden by the semantic relation.

A new identity class cannot inherit the rule of an existing class because its
printed representation happens to match.

## 6. Required phase erasure

After staging, residual run-time code is closed over compile-time bindings.
Erased values include, where applicable:

- type representations;
- effect and layout descriptors;
- reflection values;
- declaration tags;
- proof-only relationship packages;
- ownership summaries and certificates;
- included-data computations; and
- known specialization decisions.

Erasure consumes these values into residual code or checked metadata. A residual
read of an erased binding is an invariant failure.

The phase-safety obligation is contextual:

> Replacing an erased compile-time value while holding its checked residual
> artifact fixed cannot change run-time observations.

The qualification about the residual artifact matters: changing a type or layout
may legitimately produce different residual code during a fresh compilation.

## 7. Partial evaluation

An optional partial evaluator may reduce a closed pure fragment when it proves
that the replacement preserves:

- demand;
- source evaluation order;
- specified traps and divergence;
- generative identity allocation;
- relationship and ownership certificate premises; and
- source-origin information needed by diagnostics.

An empty effect row alone is not enough. A computation can still trap or
diverge, and moving it across a branch can change whether it is demanded.

Partial evaluation cannot duplicate a generative declaration, merge two module
instances, turn a one-shot demand into multiple demands, or use target layout as
a source proof.

## 8. Specialization

Specialization consumes typed residual Core plus phase, safety, ownership, and
representation facts. Before Runtime HIR it must:

1. instantiate every residual quantified use;
2. close record and variant representation choices;
3. settle every residual effect and handler representation;
4. insert or discharge representation-changing coercions;
5. specialize known higher-order and deferred choices;
6. erase compile-time and proof-only values;
7. choose a concrete representation for every residual aggregate and closure;
8. attach replayed ownership permission to destructive Store operations; and
9. retain complete public metadata for ABI closure.

Known deferred calls are normalized into ordinary residual control. Runtime HIR
has no general thunk value merely because the source used a deferred parameter.
An unresolved deferred closure that escapes known application is a stated target
refusal, not an implicit new ABI object.

A source handler's raw computation stays in its enclosing residual function
while the handler's clauses and continuations are staged. Outlining that raw
thunk before the clauses finish would retire its SSA frame while a resumed
clause still holds values from it. Imported handler builders use the same
boundary and retain their defining-module ownership contracts.

An ordinary nonrecursive source helper whose checked interface is not yet
reifiable may stay in the existing staged evaluator at a known application. This
is specialization of its checked body with actual arguments, not invention of a
runtime function signature or erasure of qualified member requirements. Every
operation and aggregate that reaches Runtime HIR still requires its resolved
member, checked ownership facts, and closed representation. A recursive helper
or a development boundary cannot use this inlining fallback. When its source
signature is not reifiable, the ordinary Rust source checker may derive an
instance signature from the actual argument and checked lexical captures.
Outlining still requires that derived interface to be settled; unresolved member
requirements, effects, or representations remain refusals. A present but
malformed interface is not treated as a missing one.

Instance checking closes the value environment over lexical free names,
excluding the parameter and recursive self binding. An unknown parameter must
never read an outer value with the same spelling, including generated loop
accumulator names. Checked expression and nested-closure facts belong to that
instance and are restored when leaving it, rather than overwriting facts for
other calls of the same source body.

An open or quantified recursive signature requests instance checking using the
same source checker. An open development-unit signature with cyclic inference
evidence also requests this check, so a finite aggregate result closes before
choosing its reload interface. An ordinary generic identity retains its checked
parameter/result relationship and the argument's representation, including
sealed carriers. Each instance identifies the source body checked at its entry.
Calls back to that body reuse its facts instead of repeatedly minting new
interfaces; a nested closure still checks its own actual argument at entry. An
empty residual Scratch contributes a fresh element unknown, and the body's
checked operations determine its element representation. Physical scalar
evidence contributes its full carrier, without inventing refinements. When
recursive lower bounds remain open, residual signature settlement combines
settled upper evidence, removing redundant bounds and neutral `Top` entries.

A nonrecursive call with a partially known argument may remain in the staged
evaluator to eliminate statically selected alternatives, even if an
alternative's payload contains runtime values. Recursive helpers, host callback
boundaries, and development boundaries still require a settled runtime
interface.

Contextual source checking must likewise preserve an expression's existing
generic representation fact. A concrete call refines its call site; it cannot
replace the shared body's fact with its own scalar, record, or vector layout.
Constructing another implementation of the same factory must not change the
representation used by an earlier implementation.

Closed checked argument evidence takes precedence over the initial value's
narrower observed type during instance checking. Surface elaboration marks the
initial accumulator argument for retention as an ordinary checked expression
fact, including stable variant fields. Residual specialization consumes that
fact rather than inferring a loop's invariant from its first iteration.

Runtime receiver lookup consults the current function's checked value evidence
before shared generic expression facts. Runtime value identities and their
checked-type table have the same function scope: starting another export resets
both. A previous export cannot determine another export's numeric dispatch. On
return through a checked call site, its result fact supersedes facts recorded
inside the generic body; intermediate arithmetic therefore retains the calling
expression's numeric domain. Unmaterialized ordering results reuse operand
identities. Their ordering type must not be recorded as the operand's type or
recovered from that operand's checked-value entry.

Source type evidence, including refinements, is retained across runtime
parameter and capture renaming. An unrefined physical carrier may identify an
integer, floating-point, collection, or recursive aggregate representation, but
cannot supply a source refinement, nominal seal, or ownership permission. The
eight built-in SIMD vector and mask types have distinct, fixed element and lane
layouts; their exact layouts identify those built-in carriers. Other vector
layouts supply no source type. Checked record requirements retain all fields of
the physical carrier, and checked integer ranges are restricted to that
carrier's bounds. A record's argument representation can be reused only for the
same checked type value, never because unrelated fields have similar shapes.
Captured record fields retain closed callable signatures independently: an
unknown field does not erase another field's quantified contract. Free
representation holes are not genuine quantified binders and must not be admitted
as rigid source evidence. Sum arguments are lowered against their
call-site-substituted representation, not the original open signature spelling.

Substitutions recovered from a known array account for every element rather than
only its first element. Integer values contribute the finite `Int` carrier.
Reification and substitution use the ordinary finite type-value union operation:
nested unions flatten and equal members collapse before runtime layout
selection.

Host-operation specialization applies one binder substitution to both the
declared parameter and result, recursively through arrays, matching constructor
payloads, and nominal resource payloads. The request retains that specialized
parameter evidence. Rebuilding an aggregate while preparing host arguments
preserves its checked representation; choosing a first element's narrower sum
after reconstruction is not a valid replacement for that evidence.

Closed callback evidence is classified by free variables. Quantifiers inside
nominal effect operations bind their own variables, including effect-row tails,
and do not make the enclosing callback open. A shared type-value occurrence must
be examined under its binder scope. An open inferred signature cannot overwrite
an attached closed signature merely because the latter mentions an effect with
polymorphic operations. Collection of all variable identities for freshness
remains a separate judgment.

### 8.1 Residual code sharing is an environment judgment

Representation equality is necessary but not sufficient for sharing a residual
function. A closure consists of source code and a lexical environment. Two
closures made from `fn name => fn value => @shape.get value name` have the same
body and argument/result representations when `name` is `"left"` or `"right"`;
they do not have the same meaning. Runtime captures also have positions: two
same-typed captures bound to `left, right` cannot be exchanged merely because
their capture-type vectors are equal.

For a closure `c`, let `E(c, slots)` be finite environment evidence in which
each runtime leaf is replaced by its position in the actual capture-argument
vector. The evidence preserves static values transitively through captured
closures, lexical type substitutions and signatures, ordered fields, aliasing,
runtime ownership meaning, and generative creation contexts. The sharing
obligation is:

```text
E(c1, slots1) = E(c2, slots2)
  and equal source body, closed signature, representations, and reuse witnesses
  implies equivalent residual bodies under corresponding runtime parameters.
```

This is a sufficient-condition contract, not a decision procedure for contextual
equivalence. Different evidence may produce separate functions even when a
stronger proof could establish equivalence. Closure graph back-references make
recursive environments finite; caller SSA numbers and environment allocation
addresses are not semantic components of the key. Addresses may only detect
visited graph nodes while constructing the trace-local evidence.

The Rust implementation uses exact, tagged structural evidence rather than
printed values or an unchecked hash. Floating values retain their bits,
including signed zero and NaN payloads. Captures retain both their runtime type
and their ownership/reuse meaning. Creation scopes and module-instance stacks
retain their complete recorded identities. Unsupported mutable authority,
deferred demand, and continuations yield no reusable environment key: the call
remains in the existing staging path, subject to its ordinary limits and target
policy. This decision is made before lowering a call argument, so declining
sharing does not emit duplicate argument work. It is not a new source rejection
or an excuse to fall back to a type-only key.

Immutable record evidence uses shared chunks once all contained closure
references are stable. The encoder retains record storage while indexing its
identity, and copy-on-write changes produce distinct evidence. Key comparison
ignores allocation sharing and memoizes compared chunk pairs; portable encoding
retains the original structural sequence. Completed keys share immutable storage
when cloned, so repeated captures and key cloning do not duplicate record trees.

Recursive result placeholders use the same environment evidence as function
identities. A placeholder for one static environment cannot be settled by a
branch from another. The evidence is local to one residual trace and is neither
a serialized cache format nor a source value-equality operation. In particular,
it does not reuse the separate, first-order compile-time result cache from
section 4.

## 9. Representation closure

Write:

```text
closedRep(hir)
```

when every Runtime-HIR value, branch join, call argument, result, field,
constructor payload, closure environment, Store element, and public boundary has
one target-admissible representation.

Runtime-HIR construction succeeds only with `closedRep`. In particular Runtime
HIR contains no:

- live inference variable;
- unresolved source `forall`;
- open structural shape;
- compile-time value or proof package;
- representation choice selected by observation order; or
- unchecked proof-required operation.

Specialization lowers a residual aggregate only against its checked closed
representation. Array prefixes, later elements, constructor payloads, recursive
arguments, and branch results share the same representation-directed lowering
judgment. Inferring an aggregate layout from its first element after checking,
or borrowing the layout of an equal-looking staged value when checked views
disagree, violates `closedRep` and is an invariant failure. A decoded immutable
aggregate may reuse a structural memo only when every recorded checked view has
the same closed representation.

Adapting an evaluated record argument to a checked parameter row preserves all
supplied fields and their insertion order. It adds only omitted fields whose
checked type admits `Unit`. Specializing deferred Scratch fields likewise
retains fields outside the checked row; that row describes required evidence,
not a projection of the argument's physical contents. An ordinary call whose
specialized parameter representation omits supplied record fields remains
staged, including when the narrower representation comes from a type-variable
substitution. Recursive evaluator bindings retain the closure's deferred calling
convention. The prelude's record operations use deferred folds over known field
names so runtime field values do not turn those names into runtime text.
Nonempty field enumeration seeds its array with the first entry, preserving the
entry representation before subsequent updates.

When a finite recursive variant result omits constructors present in its checked
codomain, settlement completes that constructor set from the finite result's
payload representations. Complete variants and non-variant results retain their
already established representation. Nested unions contribute substitutions by
constructor name. Settlement closes the complete checked constructor set,
including alternatives absent from that first result; it must not choose the
layout of an inner branch before an enclosing branch contributes its
constructors. Later results are coerced into that fixed representation. An
indirect result is loaded before applying the same structural conversion to its
pointee; constructor names, rather than private tag numbers, determine the
conversion. Before closing an export union's representation, staging uses the
checker's union-member simplification. In particular, `[Bottom] | [A]` uses the
element representation of `[A]`; the redundant empty alternative cannot require
a separate representation for `Bottom`.

The checked-aggregate memo is queried online while Runtime HIR is constructed.
Equality of its structural keys must therefore imply equality of the complete
runtime representation at the moment of lookup: runtime leaves retain their
trace-local type identity, known static leaves retain their scalar or SIMD
class, and a value with an unknown leaf or an untyped empty-array element has no
structural key. Discovering a conflicting checked view later cannot repair HIR
already emitted with the wrong layout. This online concrete-value memo is
distinct from call-specialization representation facts, whose observations are
collected before their coarser structural keys are read.

Call-specialization representation facts fill unresolved type variables. They
must not override a closed result type's own layout: a wider record accepted as
an input view does not prescribe the representation of a fresh result of that
view type. Recursive structural lowering still applies the specialized storage
rules, including Region representations, while resolving that closed result.

For a staged empty array, its stored element type is not a runtime element
value. The checked element type determines the Store representation through the
same representative-value construction used for absent variant alternatives; no
synthetic element is emitted.

A validation failure caused only by unresolved representation for a closed
accepted internal program is an `InvariantFailure`. An explicitly unsupported
public ABI type or experimental target feature may return `TargetRefusal` at its
stated policy boundary.

## 10. Artifact and cache coherence

An evaluated declaration may omit environment identity from its cache key only
when it is a top-level binding in a parameterless module and its value is safe
to reuse across module instances. Reusability of the result alone does not prove
that a local expression is independent of its constructor's arguments. Local and
parameterized-module bindings retain environment identity in both checker
evaluation and captured evaluator caches.

A staged or specialized cache entry includes every input observed by its phase:

```text
CacheKey = hash(
  compiler and certificate schema,
  source and dependency revisions,
  complete module-instance identity,
  included bytes,
  primitive catalog,
  language plan,
  target and ABI policy
)
```

A phase may omit an input only after proving it cannot observe it. Cached values
containing generative effects preserve their owning occurrence identity. Cached
seals reconstruct their canonical applicative inputs. Live inference variables,
AST object addresses, mutable worklists, and process-local proof sinks never
cross a serialized cache boundary.

Decoding validates every reference and closed identity before exposing the
artifact. A content hash proves transport integrity; it does not prove that a
package-controlled claimed interface follows from its source.

## 11. ABI handoff

Specialization supplies public-layout construction with:

- a closed source type;
- a closed Runtime-HIR representation;
- ownership policy;
- versioned target policy; and
- canonical lifting/lowering metadata.

Public-layout construction either produces a validated adapter and manifest
entry or returns `TargetRefusal`. It cannot accept a type whose required
malformed-input checks are unimplemented.

Exact ABI 4 bytes are owned by [`docs/abi.md`](../docs/abi.md); the semantic
representation relation is owned by [`RUNTIME.md`](RUNTIME.md).

## 12. Obligations

Staging and specialization owe:

1. compile-time determinism for fixed explicit inputs;
2. phase separation and absence of residual erased reads;
3. correct generative effect and applicative seal identity;
4. distinction between source failure and compiler-limit refusal;
5. demand-, trap-, divergence-, and identity-preserving partial evaluation;
6. complete residual instantiation;
7. representation closure before Runtime HIR;
8. independent replay of proof and ownership certificates;
9. cache coherence under complete observed revisions; and
10. operational adequacy between staged source, specialized Core, and validated
    Runtime HIR.

Tests and validation passes provide finite evidence for these obligations. A
successful build does not by itself prove phase safety or the whole-compiler
observation theorem.

### Strict tuple case decisions

A case whose subject is a tuple expression evaluates the complete tuple once
before selecting a row, even when the first row ignores a later field. Scalar
constructor/integer field probes are lowered to the existing scalar decision
matrix; runtime fields are not treated as failed compile-time matches. This
normalization does not flatten arbitrary product values or add support for new
payload-pattern forms. Sum dispatch includes catch-all rows in source order.

### Contextual finite recursive results

Residual calls consume the closed checked result for the current application,
using its caller context or its substituted closure signature. Staging carries
that contract through a block's result, `if` consequences, and `case` arms to
tail applications. Conditions, case subjects, declaration values, and call
arguments do not inherit it; entering another function establishes that
function's own result context. Cached expression schemes have independent
quantified identities and cannot replace the enclosing application's concrete
contract. This propagation uses checked types and performs no inference.

A recursive search whose body returns `None`, `Some T`, or its recursive result
can consequently specialize directly to the closed `Option T` representation,
including imported generic functions and suspended predicates. True recursive
payloads still use the private indirect representation and self-only equations
still require a finite constructor case.

A checked union at an export boundary is representable when all of its inhabited
members have a shared runtime representation under the existing representation
join. In particular, integer singleton bounds and `Int` share the signed-i64
carrier. This does not authorize an untagged integer/float union, invent a tag,
or change any canonical ABI layout.
