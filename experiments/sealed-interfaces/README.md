# Sealed interface experiment

This experiment measures whether the Node development checker can stop
incremental invalidation at a conservative checked-module boundary when an edit
is proved unable to change anything an importer can observe.

A type-only boundary is not sound for Blot. Checking runs the compile-time
evaluator, and an importer may execute an exported closure even when that
closure has an explicit, unchanged signature. The regression test in this
directory changes an exported `Int -> Int` closure from `+ 1` to `+ 2`: the leaf
module's canonical type interface is unchanged while the importing root's
inferred singleton changes from `42` to `43`.

`SealedCheckSession` therefore uses a conservative checked-boundary fingerprint:

```text
canonical result/effects boundary
+ canonical source for every live or potentially inference-coupled declaration
+ direct dependency fingerprints
```

Evaluator liveness is not treated as type-check liveness. For this experiment we
only forget an untagged dead private `const name = <literal>` when the binding is
also unreferenced by every other module expression/pattern/fixity and has no
attached `sig`. The proof is therefore use-closed, not merely expression-local.
Other dead declarations remain in the boundary and propagate conservatively.
Source spans are stripped before hashing so byte-width-only edits do not create
false changes.

This is intentionally check-only. It does not change Runtime HIR, artifact
caching, or the default checker. Parameter constraints are handled
conservatively rather than serialized into a new interface: any declaration that
could constrain them remains in the source boundary and therefore propagates.
Incremental state is committed transactionally: if any importer recheck fails,
none of the scratch snapshots from that request replace the previous successful
root state.

Direct dependency fingerprints are still included unconditionally. This means
the experiment can stop a local proved-isolated edit, but it cannot yet re-seal
a changed dependency at an unchanged intermediate module; that needs a richer
checked interface capable of proving which dependency observations escape.
Graph collection itself visits each module once, so shared diamond subgraphs do
not multiply traversal work by the number of paths.

The purpose is to measure whether a real compiler sealing phase is worth
designing before adding a new compiler contract.

Run the focused experiment with:

```bash
pnpm benchmark:sealed -- --depth 30 --rounds 5
```

The benchmark warms both sessions, changes one dead private literal in the leaf
of a linear dependency chain from `1` to `100` (or back), then measures the
incremental re-check. The width change deliberately verifies that source spans
are not part of the semantic boundary. The baseline `Compiler.check` follows
today's transitive loader invalidation; the sealed session rechecks the changed
leaf and stops when its observable fingerprint is unchanged.
