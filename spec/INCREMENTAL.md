# Incremental and cached compilation

## Status and principle

Incremental compilation is memoization of the fresh compiler judgment. It is not
a weaker language mode. For a phase `P`, reuse is sound only when:

```text
key_P(x) = key_P(x')    validate(cached(P(x')), x)
-------------------------------------------------
P(x) = cached(P(x'))
```

Equality includes the same semantic artifact and ordered diagnostics, modulo
only fresh administrative identities explicitly hidden by the phase relation.

Cross-document identity and failure rules are in [`COHERENCE.md`](COHERENCE.md);
the whole compiler judgment is in [`COMPILER.md`](COMPILER.md).

## 1. Revisions

A complete compilation revision includes every input any selected phase may
observe:

```text
Revision(G,tau) = hash(
  compiler and certificate schema,
  generated parser and source syntax-prelude revision,
  root and dependency source bytes,
  resolved import occurrence graph,
  included bytes and transforms,
  primitive catalog,
  package/capsule policy,
  target and ABI policy
)
```

A phase key may omit a component only after proving that phase cannot observe
it. Source identity and semantic identity are distinct. If two source texts
elaborate to equal artifacts including source origins, a downstream phase may
share a key. If a diagnostic span, import occurrence, or origin changes, that
equality does not hold.

A dependency edge contains a fixed-size digest of the dependency's canonical
phase key:

```text
key_P(m) = H(local_P(m), [(specifier_i, digest(key_P(dep_i)))])
```

The digest algorithm and canonical encoding are part of the process-local
implementation and the persistent cache namespace. Recursively embedding full
child key material is unnecessary and would repeat transitive bytes at every
edge. Host-owned import/include configuration and transport entries use
locale-independent UTF-16 code-unit ordering. Ambient collation settings cannot
change the digest of the same graph or its transport order.

An editor buffer supplies exact root-module bytes for another revision. Imports
and includes retain their resolved revisions. In-memory checking uses the same
invalidation and fresh-equivalence judgment as disk checking.

## 2. Identity separation

Cache identity must preserve the identity class owned by the cached fact:

- source expression identity for diagnostics and certificates;
- binding identity for settled interfaces and ownership summaries;
- import occurrence and complete module-instance stack for evaluated module
  results;
- generative effect occurrence for ordinary effects;
- canonical public name and invariant carrier for applicative seals;
- Store/root and produced-value lineage for destructive permissions; and
- complete revision identity for serialized artifacts.

A module definition path cannot replace a module instance. An equal source name
cannot replace an effect atom. Equal seal inputs reconstruct a seal; a
declaration occurrence is not its identity. Equal-looking intervals under
another Store are not interchangeable.

### 2.1 Compiler-owned source inspection

Source inspection runs in a dedicated Rust session that has no semantic module
configuration, checked boundary, or artifact authority. It returns literal
import and include specifiers with source spans and a deterministic portable-AST
digest. Compact syntax snapshots stay in the Rust frontend and are copied only
when formatting or editor tooling explicitly requests one. Its module handles
and revision identities remain private to that inspection session.

Node resolves the reported sites and checks them against its Baba-backed syntax
view. Dependency parity compares complete specifier sets by cardinality and
string equality; joining text with a sentinel does not establish equality. The
Rust result remains the source of semantic graph edges; parity failure rejects
the candidate. After the complete source graph succeeds, the host installs an
accepted source AST in the resident semantic session through shared immutable
Rust ownership and verifies the same dependency sets before configuration.
Portable-AST inputs remain independently decoded. Sharing an AST allocation does
not share a module revision, frontend state, configuration, checked boundary, or
semantic fact; no inspection-session identity authorizes semantic cache reuse.

The resident host memoizes local payload and direct-configuration digests by
immutable loaded-node identity. An unchanged node therefore does not serialize
its source or portable AST again during graph synchronization. Rebinding an
importer creates a new loaded node, so its direct-edge digest is recomputed;
replacing a payload likewise creates a new identity. This memoization changes
work only and does not weaken exact payload or configuration comparison.

A full workspace refresh re-resolves bare package edges even when the importing
source and previously selected target bytes are unchanged. Manifest edits,
changes to the nearest installed package, and availability of a preferred
capsule can change the selected target independently of those bytes. A refresh
with an explicitly nonempty set of changed inputs also re-resolves package
edges, including transitive edges. An unchanged resolution retains the loaded
node; a changed resolution replaces its graph wrapper without reparsing the
unchanged importer. Pending package refreshes belong to each open root:
refreshing one root must not consume another root's resolution invalidation.
They are staged with the candidate graph and cleared only for a successfully
loaded root. A known-change refresh with neither changed inputs nor a pending
package refresh for its root trusts the committed resolution and performs no
filesystem reads. Callers of that fast path are responsible for reporting
package-resolution changes.

If source inspection, dependency resolution, include loading, or syntax parity
fails, the workspace retains its prior loaded graph, roots, overlays, dirty set,
and implicit overlay sequence. The host removes candidate-only inspection
modules and every touched inspection module whose source differs from the
committed revision; an already-identical committed module may remain. No
candidate module or module-owned inspection fact remains resident. Lower parser
memoization may retain source-derived work, but it has no module identity or
semantic authority. The semantic session has not received the candidate, so its
module revisions, checked boundaries, facts, Runtime HIR, and artifacts remain
unchanged.

This isolation ends when semantic synchronization begins. This section does not
claim that a failure partway through semantic payload installation or graph
configuration rolls back the whole semantic delta.

Rust inspection and the Baba-backed host syntax view must agree on source
acceptance. Either may reject a candidate with a located syntax diagnostic.
Nonliteral include paths are rejected before semantic graph configuration.

## 3. Dependency invalidation

The source graph carries import and include edges. Changing a node marks only
that node dirty. Its next semantic request checks it in isolation and publishes
a canonical `SealedModuleBoundary` containing the compiler/schema version,
settled parameter/result/effect types, compile-time result identity, and ordered
direct-dependency boundaries. Publication is transactional: an invalid revision
has no active boundary.

An immutable result with a recursively complete structural encoding compares by
canonical value bytes. If no resident result exists, or the result contains a
closure environment, deferred environment, function-choice alternative graph,
Region Store/root, rejoin witness, or residual runtime value, the boundary
instead retains the exact producing semantic revision. A partial encoding of
such a value cannot prove equality. Exact boundary-identity equality stops
propagation. A changed boundary marks only direct importers dirty; each importer
is checked and may stop the wave in the same way. Unrelated modules retain their
identities and closed artifacts. The request-local invalidation report lists
dirty and checked modules, changed and unchanged boundaries, invalidated
importers, and reused artifacts. Telemetry is an observation and never enters a
semantic key or certificate.

Within one Rust session, a collision-free monotonic `BoundaryId` is the
fixed-size digest of a published boundary. The producing module compares its
complete canonical bytes and, when structural result encoding is unavailable,
its retained semantic-revision identity before keeping an existing boundary
identity. A parent stores only each direct dependency's identity. Neither the
boundary identity nor the process-local revision token crosses a session or
enters a persistent certificate. If a boundary changes and later returns to
earlier bytes, assigning a fresh identity may conservatively recheck importers.
Installing an immutable module snapshot mints its initial identity directly;
replacing that snapshot with source therefore always publishes a changed
boundary, even when the replacement is observationally equal.

This is the transitive reverse-dependency invalidation required for every phase
that can observe a changed edge: an unchanged sealed boundary proves that the
phase cannot observe the private change and stops its closure. Unrelated modules
retain their revisions and closed artifacts.

Resident node-indexed facts are partitioned by their owning module revision.
Invalidating a module removes that module's fact buckets directly; it does not
filter a session-wide table by re-reading every unrelated node key. Facts that
explicitly record cross-module use sites, such as specialization demand, remove
the invalidated use sites from the remaining owner bucket. This representation
changes invalidation work, not the invalidation set or fresh-equivalence rule.

An ordinary effect reachable from a published interface adds the complete owning
module-instance occurrence to the key. Reuse is sound only when that identity is
preserved. A seal instead reuses when its canonical applicative inputs are
equal.

Package resolution, include transforms, generated language-plan revisions, and
target/ABI policy participate only in the phases that observe them, but a phase
may not omit one merely because current examples do not expose a difference.

## 4. Frontend reuse

An incremental lexer may retain a token only when every source position examined
to decide that token is unchanged. Maximal munch can make the dependency extent
longer than the accepted token span.

Island parsing consumes the complete resulting token stream. The frontend reuse
theorem is:

```text
incremental_frontend(previous, edit)
  = fresh_frontend(edited_source)
```

including token identities, compact nodes, fields, edges, operator folding,
resolved AST, origins, and diagnostics.

An identical source revision reuses the complete resident compact tree without
lexing or parsing. A changed revision resynchronizes an unchanged token suffix,
publishes a deterministic old-to-new compact-node reuse map, and may reuse a
complete compact tree when the resulting syntax-token sequence is identical. The
reuse map indexes nodes by rule and source spans mapped through the maximal
unchanged prefix and suffix; it does not hash every nested source slice. Parser
bypass and AST reuse are distinct facts: changing `1` to `2` can retain the same
compact tree but must rerun CST lowering, while a trivia-only edit whose
semantic token spellings and positions are unchanged may retain the immutable
lowered AST. Every reuse decision remains subordinate to fresh-frontend
equivalence.

Operator identity uses the source syntax-prelude revision plus the normalized
fixity header of the current module. Changing a spelling, target, precedence, or
associativity invalidates lowering for that module even when its ordinary
declarations are unchanged.

## 5. Demand reuse

Declaration liveness is keyed by module revision and the enclosing block's
resolved expression identity. Replacing the module invalidates every liveness
entry before evaluation can observe another AST.

An in-process checker may stop reverse propagation after rechecking a changed
module only when a sealed boundary fingerprint is unchanged. The canonical bytes
compared by the producing module contain the closed type/effect boundary,
relational-summary schema and facts, every checked live source node that can
constrain an importer, includes, capsule input, and fixed-size dependency
identities. When no complete structural result fingerprint exists, exact
semantic-revision equality conservatively stands for the omitted value graph;
partial value bytes do not. Dead source may be omitted only by a separate proof
that it cannot affect inference, evaluation, diagnostics, or a published fact.
Cache publication is transactional: failure publishes no replacement and the
failed revision cannot consult the previous boundary as semantic authority.

A changed module may reuse evaluated declaration values only for a maximal
unchanged top-level prefix when all of these remain equal:

- module input pattern;
- generated language-plan revision;
- every reachable expression, pattern, declaration, and source origin in the
  prefix;
- resolved dependency and include mappings; and
- every semantic input observed by those declarations; and
- every retained value is recursively independent of the producing revision and
  module instance.

A change to a preceding declaration invalidates the suffix because earlier
values form the later environment. Closures, deferred environments, function
choices, effects, operations, Regions, continuations, and residual runtime
values are not revision-independent and are evaluated again even when their
declaration is in the unchanged prefix. Reuse removes deterministic evaluation
work; every declaration in the new revision is still inferred and checked unless
a separately validated closed interface is reused.

Dead source may be omitted from a key only with the source liveness proof that
it cannot affect demanded evaluation, diagnostics, ownership, or a published
fact.

## 6. Interface caches

A cached module interface may contain:

- settled closed schemes and effect rows;
- module parameter and result types;
- verified erased relational summaries;
- closure ownership contracts;
- public seal identities in canonical form;
- reachable ordinary-effect identities tied to their instance occurrence; and
- a complete dependency fingerprint.

Encoding rejects live inference variables, mutable bounds, pending worklists,
unbound rigid identities, AST object addresses, and process-local fact sinks.
Decoding validates scopes and freshens quantified identities.

A closure ownership contract is keyed by defining module revision and exact
closure-body identity. It may retain pattern identities only from the packaged
AST. An importer substitutes arguments through the published pattern; it does
not rerun dependency ownership analysis or recognize a source binding name.

A changed module may stop reverse invalidation after rechecking only when the
closed boundary fingerprint is unchanged. That fingerprint includes every live
source fact capable of constraining an importer, not merely a printed signature.
Publication is transactional: failure leaves the prior revision intact.

## 7. Checked-environment reuse

A complete checked environment may replace another module evaluation only under
the checked-environment premise in [`TYPECHECKING.md`](TYPECHECKING.md). It must
preserve:

- module-instance identity;
- compile-time values and their identity policy;
- settled interfaces;
- ownership and relationship summaries;
- staging sink contents; and
- every diagnostic-relevant origin.

The resident Rust checker publishes a module check only after its parameter,
result, effects, expression types, and closure signatures encode as a closed
flat interface. A retained expanded check therefore contains no mutable
inference variable. Failed checks and results that cannot publish that interface
are removed before the next request.

A cache hit may reuse the expanded closed check or inflate its public boundary
with fresh quantified identities. Private expression types and closure
signatures remain in the validated flat arena until evaluation first requests
their exact source-expression identity; that request freshens, reifies, and
memoizes the fact in the resident context. Caller-specific facts remain in the
importing module, and source, configuration, or dependency-boundary changes
invalidate both the memoized values and their module resolver before another
request.

## 8. Staging and specialization caches

A specialization capsule may contain deterministic compile-time values, closed
source closures, residual Core, and closed representation choices. Its key
includes every explicit input the staged computation observed.

A resident result for a nullary module with an empty checked effect row is such
a capsule only when its closed result type exposes no generative effect identity
and the actual value is recursively independent of its producing module
instance. Importing that module may then reuse the result directly. Closures,
deferred environments, function choices, effects, operations, Regions,
continuations, and residual runtime values keep the complete written
module-instance occurrence and are not shared directly. A validated snapshot may
retain their compile-time environment as a revision-keyed template. Each import
decodes that template over its own module-instance and effect-scope prefix, then
evaluates only the module result expression. This skips declaration replay
without merging written occurrences.

An instantiated template environment is reusable only after it is fully sealed
and only for the exact imported-module revision, complete module-instance stack,
and complete effect-scope stack. This is an environment cache, not a
module-result cache: a hit still evaluates the result expression for that
occurrence. Distinct occurrence provenance cannot share an entry, and
invalidating any referenced module revision removes the entry. These conditions
preserve per-occurrence closure and generative identity while avoiding repeated
structural decoding of an unchanged trusted capsule. This opportunistic cache
admits only provenance with at most 32 module-instance, nested effect-scope, or
compiler-request levels and 256 counted module-instance sites, effect frames,
and compiler steps. Admitted provenance must also keep the decoded capsule's
base allocation plus caller-prefix copies within the 64 MiB capsule allocation
bound: the module-instance prefix is copied once per stored closure and identity
key, and the effect-scope prefix once per non-empty stored scope. Deeper
provenance or an excessive prefix/capsule cross-product skips template decoding
and replays declarations. The cache retains at most 64 environments; a miss at
that bound starts a fresh cache generation before inserting the new exact key.
Its retained memory is therefore independent of dynamic recursion depth and the
number of import occurrences.

On a template-instance miss, one structural fold both revalidates the capsule's
logical budget and prices those caller-prefix copies. Success creates an
ephemeral admission fact borrowing the exact capsule; consuming that fact enters
the remaining graph and provenance validation without repeating the structural
fold. The fact is neither serializable nor cacheable, cannot be transferred to a
different capsule, and does not alter the instance key or decoded-environment
identity. A structurally invalid installed capsule therefore remains an
invariant failure, while only excessive caller provenance or allocation selects
declaration replay.

Every environment decoded under an admitted key carries an immutable semantic
identity interned by the imported-module revision, the complete template
provenance, and the capsule's encoded environment ID. Evicting and later
decoding the same exact key therefore preserves closure-source equality and
cannot change Runtime-HIR function-choice cardinality. Different encoded
environments remain different even when they contain the same lambda. Oversized
provenance does not produce a decoded environment; ordinary declaration replay
retains the conservative allocation-identity rule. The interner holds only weak
references, sweeps dead entries at geometric thresholds, and removes every
affected key on revision invalidation. A removed token survives only while a
decoded environment still owns it.

Ordinary effects retain complete generative occurrence identity. Seals retain
canonical applicative inputs. A staged result containing process-local mutable
state, unresolved polymorphism, live proof values, or unvalidated private
references is not serializable.

Runtime HIR and emitted artifacts use the strongest revision of any source,
certificate, target, ABI, or language-plan input they observe. Revalidation is
required after decoding; a content hash establishes transport integrity, not the
semantic truth of a producer-controlled interface claim.

An unchanged development request may reuse a closed development program only
after the semantic request has processed every pending invalidation. Its key is
the program root and exact ordered unit-name-to-root mapping. A source or
dependency-boundary invalidation removes the entry before another request. This
cache skips checking and Runtime-HIR reconstruction for a no-op request; it does
not change staging, specialization, or source meaning.

The resident development-artifact cache has one committed map and at most one
pending update. Preparing a program abandons the previous pending update before
any fallible work, reads only the committed map, and stages replacements plus
the exact active cache-key set under a fresh transaction identity. Each artifact
key contains the complete ordered unit-name-to-root mapping, and each committed
artifact retains the source-module membership of its split unit. After semantic
invalidation settles, a unit whose prior membership is disjoint from the checked
impact cone and whose exact function/link partition is unchanged skips
unit-module construction, identity serialization, ABI closure, and emission. The
splitter still traces calls and reload edges so a changed cross-unit demand
rebuilds both sides of that boundary. Checked units are rebuilt and compared by
their complete canonical Runtime HIR; this conservative step is required because
an imported compile-time value can change generated code without changing
consumer source. Preparation does not insert or prune committed entries. A
failed preparation therefore publishes nothing. Commit accepts only the current
identity, applies all staged replacements and exact-key pruning in one mutation,
then consumes the identity. A stale, duplicate, or missing identity changes
nothing. An abandoned reduced unit set cannot prune committed units, and
replacing a configured root prunes the exact former key only when its
replacement commits.

The host copies and hashes every compiled unit, resolves identity-only cache
hits against private retained artifacts, and computes the canonical development
revision before committing the Rust transaction. Caller-visible compiled bytes
and capabilities never alias the host's retained identities or artifact
reservoir. Failure in this host work leaves both committed caches unchanged, so
the next preparation recompiles the uncommitted Rust units and can retry against
the same host baseline.

## 9. Prelude and package snapshots

The prelude is an ordinary module under the same semantic rules. A distributed
prelude snapshot may contain compact AST, a closed checked interface,
compile-time-value capsule, certificates, and prepared Runtime HIR only when its
manifest names the exact:

- prelude source and dependency closure;
- compiler and certificate schema;
- generated parser and source syntax-prelude revision;
- primitive catalog; and
- target/ABI policy.

Loading validates arena references, closed rigid-variable scope, certificate
schema, and semantic identity before exposing an artifact. A source-backed cache
may fall back to ordinary compilation after validation failure. A compiler-
distributed snapshot instead reports corrupt distribution when its authority is
the distribution itself.

Compiler-host ABI 4 introduced trusted-snapshot installation separately from
graph deltas, and ABI 6 preserves that boundary. The bundled host invokes it
only after the artifact manifest authenticates the prelude digest. A caller
supplying a custom compiler and snapshot explicitly owns that trust decision.
Source, portable-AST, configuration, and removal deltas cannot carry snapshot
bytes, and registry packages cannot reach this authority. Development-program
preparation and commit are separate ABI 5 session operations. ABI 6 adds
inspection-AST sharing and on-demand syntax-snapshot operations; neither widens
the graph-delta or trusted-snapshot decoder.

Snapshot preparation is transactional. The AST, interface, compile-time capsule,
and result evaluation are completed in path-scoped staging state before the
resident module, invalidation graph, or identity counters change. A failed
installation leaves any prior resident module and its published boundary intact.
Before recursive MessagePack deserialization, installation scans the complete
byte slice iteratively and requires exactly one well-formed root with no
trailing bytes or reserved marker. Snapshot bytes are limited to 32 MiB,
MessagePack nesting to 128 levels, structural nodes to 1,048,576, and estimated
allocation to 64 MiB under protocol-fixed weights. Export applies the same
preflight after serialization, so the compiler cannot publish a snapshot that
its trusted installer refuses. After deserialization, portable AST and checked-
certificate flat graphs are admitted iteratively before semantic traversal.
Every AST arena node and flat-type root has a maximum reference-path depth of
128 edges and an expanded-reference budget of 1,048,576 nodes, counting repeated
DAG edges separately. The AST additionally aggregates its parameter,
declaration, and result roots; the certificate aggregates its result, effects,
parameter, expression-type, and closure-signature roots. Export validates the
same logical budgets before serializing either portable artifact. The value
capsule limits nested values, applications, effect-scope creation, and module-
instance sites to 128 logical levels. It encodes lexical environment shells
iteratively and limits every path through the complete
parent-and-closure-capture graph to 1,024 edges. The same node and allocation
budgets apply before reference validation and reconstruction. An over-budget
installed snapshot is a corrupt or unacceptable trusted distribution, not a
source diagnostic; refusal publishes no staged state. If the optional
source-side capsule exceeds either its logical budget or the serialized
snapshot's wire budget, publication retries without that environment cache. The
capsule-less AST and certificate are preflighted again, and declaration replay
remains authoritative. The generated prelude snapshot must retain its admitted
environment capsule; its artifact regression rejects a capsule-less prelude
because every import would otherwise replay all prelude declarations.

Effect declarations and extensions created by `@type.attach` are exact-identity,
module-owned resident-context facts. The declaration retains the effect's
operation metadata; later module-owned attachments form overlays, so removing an
attachment reveals the declaring value. Staging excludes the replaced module's
prior facts and publishes new ones only with the successful snapshot. They
cannot leak from a failed installation, another module's same-spelled effect, or
another compiler session.

The cached-interface path requires all three of an eligible compile-time
environment, a certificate with no generative effect label or opaque effect
identity, and a validated AST containing no `@effect` or `@effect.host`
constructor. Only then may installation borrow the decoded immutable type arena
and install the interface after the AST without cloning the arena or validating
the same certificate twice. A captured closure's application and module-instance
provenance remains complete: the capsule records the scope graph only when every
root names the snapshot module's current revision, validates every referenced
AST node on installation, and remaps the roots to the installed revision. Every
other snapshot still validates its supplied certificate and AST references, then
performs an ordinary Rust check in staging. A nullary module is evaluated there;
a parameterized module remains unevaluated until an ordinary `import ... with`
supplies its argument. Generative effects therefore receive the receiving
session's occurrence identities and retain their operation and attached-member
metadata rather than transplanting producer-local labels. The pinned snapshot
path also does not construct the source-inspection portable-AST digest, because
its manifest-validated snapshot digest is already the revision identity. An
eligible environment remains installed as a module-result template keyed by that
revision. Template decoding prepends the importing runtime's complete
module-instance and effect-scope stacks to every reconstructed closure; source
or configuration invalidation removes the template before renewing the revision.

The compiler host seeds the resolved graph's prelude leaf from the validated
snapshot AST and pins that leaf to the compiler instance. It does not reparse a
source twin merely to rediscover the snapshot's dependency-free graph.
Formatting and editor requests over source remain ordinary syntax consumers. The
pinned leaf's revision is the validated snapshot digest; ordinary semantic
commands therefore do not export or decode its portable AST. A syntax consumer
that explicitly requests that AST materializes it lazily from the installed
snapshot.

Registry capsules remain package-controlled inputs. A package hash proves only
unchanged transport. It does not prove that a claimed interface follows from its
AST unless a separately checked certificate establishes that judgment more
cheaply than ordinary checking.

Workspace roots and editor overlays have independent ownership. A successful
root load or overlay update claims that path as a root. Releasing the root does
not clear its overlay, and clearing the overlay does not release the root. A
released node remains resident when another root still reaches it; otherwise the
host removes its loaded revision and dirty inputs, then removes the
corresponding inspection and semantic modules. Pinned compiler-distribution
modules are not owned by workspace roots.

Closing an overlay invalidates its source input once, then transactionally
rebinds every remaining root whose committed graph reaches that input. All of
those roots observe the disk replacement, or none of them commit. With no
remaining affected root, close clears the overlay without reading or installing
the path. This permits an editor to close an unsaved, diskless document by
releasing its root before closing its overlay.

An active workspace graph owns the resident module set. Removing a node from
that set removes its frontend snapshot, mutable inference generation,
compile-time evaluation caches, effect-identity entries, closed programs, and
request-local analyses. It also removes closed development programs and
committed development artifacts whose program or unit root names that node.
Every direct importer is invalidated before that dependency disappears, so no
importer can reuse an environment, boundary, or closed program containing the
removed value. A later module with the same path is a new revision and must
install and validate its payload again. Stable sealed boundaries and checked
snapshots are self-contained; none retains a live variable or another private
generation merely because a removed module once published it.

## 10. Diagnostic and limit reuse

A cached `SourceDiagnostic` is reusable only under the exact source and semantic
inputs that make its failed premise stable.

A cached `LimitDiagnostic` additionally names the configured deterministic
resource bound. It does not become a source diagnostic. Raising the bound must
miss or reclassify the cache entry so the same source may continue checking.

`TargetRefusal` includes target and ABI policy in its key. `InvariantFailure` is
not a reusable semantic result; it signals a compiler defect or corrupt
artifact.

## 11. Parallel work

Independent ready modules may run concurrently. Commit order follows canonical
module order; diagnostics follow source order. No mutable inference graph,
ownership state, or staging sink crosses a worker boundary.

A parallel schedule is valid only when its final diagnostics, interfaces,
certificates, Runtime HIR, manifest, and emitted bytes equal the sequential
fresh judgment.

## 12. Verification

Fresh-versus-incremental tests cover:

- replacement, insertion, deletion, and token merging;
- operator-plan revision changes;
- import occurrence and dependency changes;
- include bytes and transform changes;
- ordinary generative-effect changes and applicative seal reconstruction;
- ownership/certificate identity changes;
- source versus limit diagnostic changes;
- target and ABI policy changes; and
- concurrent scheduling.

Tests compare invalidation sets, ordered diagnostics, settled interfaces,
certificates, staged values, Runtime HIR, manifest bytes, WebAssembly bytes, and
source/Wasm observations. A timing improvement without fresh-result equivalence
is not a valid incremental optimization.
