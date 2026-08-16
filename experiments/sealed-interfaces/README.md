# Sealed checked-interface cache

This directory retains the correctness and performance harness for the
production `IncrementalCheckCache`. The Node development checker can stop
incremental invalidation at a conservative checked-module boundary when an edit
is proved unable to change anything an importer can observe.

A type-only boundary is not sound for Blot. Checking runs the compile-time
evaluator, and an importer may execute a returned closure even when that closure
has an explicit, unchanged signature. The regression test in this directory
changes a returned `Int -> Int` closure from `+ 1` to `+ 2`: the leaf module's
canonical type interface is unchanged while the importing root's inferred
singleton changes from `42` to `43`.

`SealedCheckSession` therefore uses a conservative checked-boundary fingerprint:

```text
canonical result/effects boundary
+ verified relational-summary fingerprint and schema
+ canonical source for every live or potentially inference-coupled declaration
+ direct dependency fingerprints
```

Evaluator liveness is not treated as type-check liveness. For this experiment we
only forget an untagged dead private `const name = <literal>` when the binding
is also unreferenced by every other module expression/pattern/fixity and has no
attached `sig`. The proof is therefore use-closed, not merely expression-local.
Other dead declarations remain in the boundary and propagate conservatively.
Source spans are stripped before hashing so byte-width-only edits do not create
false changes.

This remains check-only: Runtime HIR and artifact caching retain their stronger
exact-revision keys. It is now the default path for `Compiler.check`. Parameter
constraints are handled conservatively rather than serialized into a new
interface: any declaration that could constrain them remains in the source
boundary and therefore propagates. Incremental state is committed
transactionally: if any importer recheck fails, none of the scratch snapshots
from that request replace the previous successful root state.

Direct dependency fingerprints are still included unconditionally. This means
the experiment can stop a local proved-isolated edit, but it cannot yet re-seal
a changed dependency at an unchanged intermediate module; that needs a richer
checked interface capable of proving which dependency observations escape. Graph
collection itself visits each module once, so shared diamond subgraphs do not
multiply traversal work by the number of paths.

The old experiment implementation has been removed; these tests import the
production cache directly.

Run the focused experiment with:

```bash
pnpm benchmark:sealed -- --depth 30 --rounds 5
```

The benchmark warms both paths, changes one dead private literal in the leaf of
a linear dependency chain from `1` to `100` (or back), then measures the
incremental re-check. The width change verifies that source spans are not part
of the semantic boundary. The baseline forces a fresh whole-root check; the
production compiler rechecks the changed leaf and stops when its fingerprint is
unchanged.

On Node v26.7.0, nine alternating 100-module samples measured 72.54 ms for the
whole-root check and 51.51 ms for the production cache, a 1.41x end-to-end
speedup. Semantic checking fell from 100 modules to one; graph refresh remains
in both measurements and is now the dominant incremental cost.
