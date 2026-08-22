# Blot Core model

This Lake package pins the Lean version in `lean-toolchain` and models the
smallest trusted value/computation boundary. It deliberately omits modules,
reflection, storage layouts, the ABI, and the production compiler's arena
representation.

## Checked scope

`Blot/Core.lean` defines the computation/effect seed calculus:

- separate value and computation syntax with hygienic names;
- binder-respecting substitution under hygienic names through variants,
  functions, definitions, binds, applications, handlers, and captured
  continuations;
- data flow from a `define`, a computation result through `bind`, and a function
  argument through application;
- ordered effect traces;
- direct handler return and operation redexes; and
- an argument-substituting one-shot continuation transition with explicit
  cancellation.

The checked lemmas state those local rules. In particular, they do not call a
`define` transparent while ignoring its value or call two independent
computations a data-carrying bind.

`Blot/Stable.lean` then fixes the first production correspondence boundary. It
contains:

- intrinsically typed residual terms for live pure bindings, finite function
  choices, variants with exhaustive cases, effects and handlers, checked signed
  addition, proof-bearing array reads, specified traps, and divergence;
- structural preservation and an executable value/step/divergence/trap
  classifier;
- compile-time binding erasure lemmas;
- structural ownership predicates and proofs of no double move, affine
  at-most-once use, and linear exact use on terminating exits;
- a bounds-safety theorem for the only array-read constructor; and
- a small Runtime-HIR-to-target evaluator simulation.

The package contains no `sorry` or admitted axioms. CI builds it, asks Lean's
standalone `leanchecker` to check the generated declarations independently, and
rejects `sorry`, `admit`, or `axiom` declarations in the formal source.

## Correspondence boundary

The syntax is a model of the stable subset, not a serialization of the
TypeScript or Rust arenas. The correspondence is structural: `Term` mirrors
typed Core's result index and closed residual forms; `HirOperation` mirrors the
validated integer, branch, proved-array, and host-effect operations that cross
the backend boundary. Source modules, parsing, reflection, SIMD, desugarings,
and the public ABI remain intentionally outside this first artifact.

The bounded TypeScript/Rust parity, mutation, artifact-reproducibility, ABI, and
emitted-Wasm gates remain authoritative executable checks. The mechanization
supplements them; it does not replace them.

Run `lake build` from this directory.
