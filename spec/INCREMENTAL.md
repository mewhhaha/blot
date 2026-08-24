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
  generated parser and operator plan,
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
edge.

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

## 3. Dependency invalidation

The source graph carries import and include edges. Changing a node invalidates
that node and the transitive reverse-dependency closure for every phase that can
observe the changed edge. Unrelated modules retain their revisions and closed
artifacts.

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

Operator identity uses the generated fixed language-plan revision. Source
modules have no custom fixity environment to preserve or compare.

## 5. Demand reuse

Declaration liveness is keyed by module revision and the enclosing block's
resolved expression identity. Replacing the module invalidates every liveness
entry before evaluation can observe another AST.

A changed module may reuse evaluated declaration values only for a maximal
unchanged top-level prefix when all of these remain equal:

- module input pattern;
- generated language-plan revision;
- every reachable expression, pattern, declaration, and source origin in the
  prefix;
- resolved dependency and include mappings; and
- every semantic input observed by those declarations.

A change to a preceding declaration invalidates the suffix because earlier
values form the later environment. Reuse removes deterministic evaluation work;
every declaration in the new revision is still inferred and checked unless a
separately validated closed interface is reused.

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

The current Node resident checker deliberately uses a narrower boundary for
retained full checks. A dependency may retain a complete local check only when
it is a leaf, has no explicit module input, publishes a closed specialization
interface, and exposes no generative ordinary-effect atom across the retained
boundary.

The first check runs against an isolated staging sink. A later importer installs
only the closed interface and freshly instantiates its schemes. Caller-specific
facts and mutable inference state never cross the boundary. A new leaf revision
misses the cache.

## 8. Staging and specialization caches

A specialization capsule may contain deterministic compile-time values, closed
source closures, residual Core, and closed representation choices. Its key
includes every explicit input the staged computation observed.

Ordinary effects retain complete generative occurrence identity. Seals retain
canonical applicative inputs. A staged result containing process-local mutable
state, unresolved polymorphism, live proof values, or unvalidated private
references is not serializable.

Runtime HIR and emitted artifacts use the strongest revision of any source,
certificate, target, ABI, or language-plan input they observe. Revalidation is
required after decoding; a content hash establishes transport integrity, not the
semantic truth of a producer-controlled interface claim.

## 9. Prelude and package snapshots

The prelude is an ordinary module under the same semantic rules. A distributed
prelude snapshot may contain compact AST, a closed checked interface,
compile-time-value capsule, certificates, and prepared Runtime HIR only when its
manifest names the exact:

- prelude source and dependency closure;
- compiler and certificate schema;
- generated parser and operator plan;
- primitive catalog; and
- target/ABI policy.

Loading validates arena references, closed rigid-variable scope, certificate
schema, and semantic identity before exposing an artifact. A source-backed cache
may fall back to ordinary compilation after validation failure. A compiler-
distributed snapshot instead reports corrupt distribution when its authority is
the distribution itself.

Registry capsules remain package-controlled inputs. A package hash proves only
unchanged transport. It does not prove that a claimed interface follows from its
AST unless a separately checked certificate establishes that judgment more
cheaply than ordinary checking.

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
