# Incremental and cached compilation

## 1. Principle

Incremental compilation is memoization of the fresh compilation judgment. It
does not define a weaker language mode. For a phase `P`, reuse is sound when

```text
key_P(x) = key_P(x')    validate(cached(P(x')), x)
-------------------------------------------------
P(x) = cached(P(x'))
```

where equality means the same semantic artifact and diagnostics, modulo fresh
internal identities explicitly hidden by the phase relation.

## 2. Revisions

A module revision includes every input the module may observe:

```text
Revision(m) = hash(
  compiler schema,
  generated parser plan,
  source bytes,
  resolved import revisions,
  included bytes and include transform,
  primitive catalog,
  target and ABI policy
)
```

A phase key may omit a component only after proving that phase cannot observe
it. Source identity and semantic identity are distinct. If lowering two source
texts produces equal ASTs including source origins, downstream semantic phases
may share a revision. If an edit moves a diagnostic span, that equality does not
hold.

A recursive key names each direct dependency by a fixed-size digest of that
dependency's own canonical key material:

```text
key_P(m) = H(local_P(m), [(specifier_i, key_P(dep_i))])
```

`key_P(dep_i)` is the digest, not the serialized payload that produced it.
Recursively embedding complete child keys is semantically redundant and makes an
importer's key construction repeat transitive dependency bytes. Digesting the
canonical child key once preserves the same phase equality while bounding every
dependency edge to constant-size identity material. The digest algorithm and
canonical encoding are part of the process-local compiler implementation; a
persistent cache additionally namespaces them by compiler/schema version.

An editor buffer is another supplier of the root module's exact source bytes,
not a weaker checking mode. Checking an in-memory root revision replaces that
module's source component while its imports and includes retain their resolved
filesystem revisions. The resident compiler applies the same invalidation and
fresh-compilation judgment as it does after a disk edit.

## 3. Dependency invalidation

The source graph carries import and include edges. Changing a node invalidates
that node and the transitive reverse-dependency closure for every phase that
observes the changed edge. Unrelated modules retain their identities and closed
artifacts.

Generative declarations add an identity dependency. Reusing a module interface
is sound only when every generative identity reachable from that interface is
preserved by the same revision. Otherwise specialization and effect equality
must miss the cache.

## 4. Frontend reuse

An incremental lexer may retain a token only when the source prefix containing
every code point examined to decide that token is unchanged. The dependency end
can exceed the accepted token end because maximal munch observes the following
input. All other tokens are rederived. Island parsing then consumes the complete
resulting stream.

The frontend reuse theorem is:

```text
incremental_frontend(previous, edit) = fresh_frontend(edited_source)
```

including token arrays, compact nodes, edges, AST, and diagnostics. Prefix reuse
is an implementation technique, not a different parser contract.

## 5. Interface and specialization caches

A cached module interface contains settled closed schemes, effects, result and
parameter types, verified erased relational summaries reachable from the
compile-time boundary, and a dependency fingerprint. Encoding rejects live
inference variables and unbound rigid identities. Decoding instantiates
quantified identities freshly.

An in-process checker may stop reverse propagation after rechecking a changed
module only when a sealed boundary fingerprint is unchanged. That fingerprint
contains the closed type/effect boundary, relational-summary schema and facts,
every checked live source node that can constrain an importer, includes, capsule
input, and dependency fingerprints. Dead source may be omitted only by a
separate proof that it cannot affect inference, evaluation, diagnostics, or a
published fact. Cache publication is transactional: failure leaves the previous
revision intact.

A specialization capsule additionally contains deterministic compile-time values
and closed source closures. Its coherence law is given in
[`TYPECHECKING.md`](TYPECHECKING.md). Mutable bounds, pending worklists, AST
object identities, and fact sinks do not cross the cache boundary.

Checked compile-time environments, ownership results, safety certificates,
Runtime HIR, and emitted artifacts may be retained only under the strongest
revision of any input they observe. A complete checked environment may replace a
second module evaluation only under the `checked-environment` premise in
[`TYPECHECKING.md`](TYPECHECKING.md).

The Node resident checker currently uses a deliberately narrower full-check
boundary. A dependency may retain its complete locally settled check only when
it is a **leaf**, takes no module parameter, publishes a closed specialization
interface, and that interface carries no generative effect brand. The first
check runs against an isolated staging sink and settles before publication; a
later importer reinstalls only the closed interface into its own staging sink.
The retained module result is a read-only scheme template: the ordinary
`@import` rule freshens it before importer constraints are added. Therefore
caller-specific fact reads and mutable inference instances do not cross the
cache boundary. A new leaf revision misses because loader identity changes.
Closed interfaces with generative brands may be used by the compilation that
created them but are not retained across compilations; unclosed and
parameterized leaves take the ordinary per-compilation path.

A changed module may retain successful declaration-value evaluations only for
its maximal unchanged top-level declaration prefix. Equality includes the module
parameter and fixities plus every reachable expression, pattern, declaration,
and source span in that prefix. The resolved dependency and include mappings
must also be unchanged. A change to any preceding declaration invalidates the
suffix because its values form the later declarations' environment; a dependency
change invalidates the importer through the ordinary reverse-dependency closure.
Reuse removes deterministic evaluation only: every declaration in the new
revision is still inferred and checked.

Declaration liveness is derived from a lowered module and may be cached by
module path plus the enclosing block's expression identity. Replacing that
module invalidates every such entry before evaluation can observe the
replacement AST.

## 6. Prelude snapshots

The prelude is an ordinary module and obeys the same rules. A distributed
prelude snapshot may contain compact AST, closed checked interface,
compile-time-value capsule, certificates, and prepared Runtime HIR. Its key must
include the exact prelude source, compiler schema, parser plan, dependency
closure, primitive catalog, and target policy.

Loading the snapshot validates its schema, arenas, and references before
exposing any artifact. A cache snapshot whose source is independently available
may fall back to ordinary compilation after validation fails. A
compiler-distributed snapshot instead fails as a corrupt distribution because
its authority comes from that distribution, not from a self-reported content
hash. A snapshot is a serialized certified cache entry, not an intrinsic or
privileged prelude.

The same rule applies to registry-distributed modules. The portable capsule
format and its source fallback are specified in [`PACKAGES.md`](PACKAGES.md).
The current schema caches the validated lowered AST graph only; it deliberately
makes no checked-interface or specialization-cache claim.

The full Rust compiler additionally ships the dependency-free prelude's portable
AST and closed checked interface as a generated artifact beside the compiler
WebAssembly. The loader resolves the explicit `blot:prelude` import to that
artifact, installs it under the same module identity, and evaluates its
validated AST once per compiler session. The compiler artifact is already part
of the trusted computing base, so this is equivalent to retaining a successful
frontend and check in a process cache across compiler sessions. The build
regenerates the snapshot from the exact source with the current Baba plan and
checker; its check mode rejects a stale snapshot. Loading validates the AST
arena, certificate schema, every flat-arena reference, and closed rigid-variable
scope before installing it. The compiler then evaluates the validated module
once per session and retains that compile-time result rather than asserting a
serialized value graph.

This authority does not extend to registry capsules. A package-controlled hash
proves only that its payload was transported unchanged; it cannot prove that the
package's claimed interface follows from its AST. Registry modules continue
through ordinary checking until Blot has a proof certificate whose validation is
cheaper than reconstructing the judgment.

## 7. Determinism under parallel work

Independent ready modules may run concurrently. Commit order follows canonical
module order, and diagnostic order follows source order. No mutable inference
graph crosses a worker boundary. A parallel schedule is valid only if its final
artifact equals the sequential judgment byte for byte.

## 8. Cache verification

Tests compare fresh and incremental compilation after replacement, insertion,
deletion, token merging, import changes, include changes, and generative
declaration changes. They compare diagnostics, settled interfaces, certificates,
Runtime HIR, ABI bytes, WebAssembly observations, and invalidation sets. A
timing improvement without this equality is not an incremental compiler
optimization.
