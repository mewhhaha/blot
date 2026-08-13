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
canonical result/effects/module-parameter boundary
+ canonical source for every live or inference-coupled declaration
+ direct dependency fingerprints
```

Evaluator liveness is not treated as type-check liveness. For this experiment we
only forget an untagged dead private `const name = <literal>`, because that tiny
form is closed and cannot constrain importer-visible inference state. Other dead
declarations remain in the boundary and propagate conservatively. Source spans
are stripped before hashing so byte-width-only edits do not create false changes.

This is intentionally check-only. It does not change Runtime HIR, artifact
caching, or checking semantics; it only exposes the checker's existing canonical
module-function interface for the experiment. The purpose is to measure whether
a real compiler sealing phase is worth designing before adding a new compiler
contract.

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
