# Blot Core model

This Lake package pins the Lean version in `lean-toolchain` and models the
smallest trusted value/computation boundary. It also contains non-authoritative
QCore shadow artifacts. The package deliberately omits reflection, storage
layouts, the ABI, and a proved translation from the production compiler.

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

`Blot/QCoreGenerated.lean` mirrors the generated version-3 arena schema, and
`Blot/QCore.lean` mirrors its structural scopes and grade algebra.
`Blot/QCoreTyping.lean` defines a separate declarative calculus for the strict
pure subset accepted by the executable Rust shadow kernel. It includes de Bruijn
weakening and substitution functions, syntactic occurrence grades, dependent
`Pi` and `Sigma` typing, and beta/projection conversion. It does not prove that
the Rust checker implements those judgments; the missing correspondence and
metatheorems are listed in `spec/QCORE_TYPING.md`.

The package contains no `sorry` or admitted axioms. CI builds it, asks Lean's
standalone `leanchecker` to check the generated declarations independently, and
rejects `sorry`, `admit`, or `axiom` declarations in the formal source.

## Correspondence boundary

The syntax is a model of the stable subset, not a serialization of the Rust
arenas. The correspondence is structural: `Term` mirrors typed Core's result
index and closed residual forms; `HirOperation` mirrors the validated integer,
branch, proved-array, and host-effect operations that cross the backend
boundary. Source modules, parsing, reflection, SIMD, desugarings, and the public
ABI remain intentionally outside this first artifact.

The Rust evaluator/emitted-Wasm agreement, mutation, artifact-reproducibility,
ABI, and conformance gates remain authoritative executable checks. The
mechanization supplements them; it does not replace them.

Run `lake build` from this directory.
