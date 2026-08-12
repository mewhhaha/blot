# Sealed interface experiment

This experiment measures whether the Node development checker can stop
incremental invalidation at a module boundary when an implementation edit does
not change anything an importer can observe.

A type-only boundary is not sound for Blot. Checking runs the compile-time
evaluator, and an importer may execute an exported closure even when that
closure has an explicit, unchanged signature. The regression test in this
directory changes an exported `Int -> Int` closure from `+ 1` to `+ 2`: the
leaf module's canonical type interface is unchanged while the importing root's
inferred singleton changes from `42` to `43`.

`SealedCheckSession` therefore uses a conservative observable fingerprint:

```text
canonical module type
+ live source slice
+ direct dependency fingerprints
```

The live source slice uses the same `liveDeclarations` calculation as the
comptime evaluator and lowering. Dead private declarations are still checked in
the module that owns them, but changes to them do not invalidate importers. A
change to exported/live code, or to any dependency's observable fingerprint,
propagates normally.

This is intentionally check-only. It does not change Runtime HIR or artifact
caching, and it does not change the default checker. The purpose is to measure
whether a real compiler sealing phase is worth designing before adding a new
compiler contract.

Run the focused experiment with:

```bash
pnpm benchmark:sealed -- --depth 30 --rounds 5
```

The benchmark warms both sessions, changes one dead private binding in the leaf
of a linear dependency chain, then measures the incremental re-check. The
baseline `Compiler.check` follows today's transitive loader invalidation; the
sealed session rechecks the changed leaf and stops when its observable
fingerprint is unchanged.
