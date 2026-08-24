# Remaining work

Current protocol, backend, ABI, editor, and benchmark status is generated in
[`generated/CURRENT_IMPLEMENTATION.md`](generated/CURRENT_IMPLEMENTATION.md).

There are no remaining items in this roadmap. The five compiler tasks that were
listed here are complete; new language features and capacity-bearing Stores
remain outside its scope.

## Completed compiler boundaries

1. **Rust compiler host.** `Compiler` gives the Rust/Wasm compiler the resident
   `check`, `analyze`, `evaluate`, `test`, `prepare`, `compile`, and `destroy`
   contract used by every semantic command. It installs exact source graphs and
   transports source diagnostics, target refusals, and compiler invariant
   failures without synthetic source locations.

2. **Closed `collect` inference.** Empty-array origins constrain the same
   homogeneous element variable as recursive pushes.
   `collect (Iter.range
   (0, 4))` has the principal result `[Int]` while empty
   iteration remains valid. The executable contract is
   `examples/collect_principal_type.blot`.

3. **Progressive Runtime HIR.** Typed Core nodes carry structural type
   identities and explicit settled or pending HIR-builder state. Closed static
   nodes commit their final residual contribution during checking; structural
   folds, representation choices, and specialization remain pending without a
   fallback representation. Runtime-HIR preparation consumes the existing
   checked artifact, structural specialization keys replace formatted types, and
   revision reuse preserves exact source origins. The measured boundary and
   byte-identical artifact check are recorded in
   `experiments/progressive-hir-performance.md`.

4. **Single semantic implementation.** TypeScript semantic passes and the
   dual-compiler parity inventory were removed. The Rust evaluator and emitted
   Wasm remain independent observations of one checked program.

5. **Mechanized stable core.** `formal/lean/Blot/Stable.lean` contains the first
   intrinsically typed stable residual model: pure bindings, finite function
   choices, variants and exhaustive cases, effects and handlers, classified
   traps and divergence, proof-bearing array reads, phase erasure, structural
   affine/linear use, and Runtime-HIR-to-target simulation. Lake and CI check it
   without `sorry` or admitted axioms.

## Release gates

The normal handoff remains:

```sh
just check
just test
```

Compiler-artifact changes additionally rebuild the Rust compiler and prelude
snapshot, verify reproducibility, run the Rust compiler integration suite, and
run `pnpm conformance` against the focused runtime corpus. `LANGUAGE.md` and the
focused compiler specifications remain part of the same change whenever their
contracts move.
