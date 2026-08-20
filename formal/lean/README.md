# Blot Core model

This Lake package pins the Lean version in `lean-toolchain` and models the
smallest trusted value/computation boundary. It deliberately omits modules,
reflection, storage layouts, the ABI, and the production compiler's arena
representation.

## Checked scope

`Blot/Core.lean` currently defines:

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

The checked lemmas state those local rules. In particular, they no longer call a
`define` transparent while ignoring its value or call two independent
computations a data-carrying bind.

## Correspondence boundary

The syntax is a seed calculus for Blot's typed Core, not a serialization of the
production TypeScript or Rust arenas. It models return values, ordered effects,
and the ready-to-spent continuation transition. The next correspondence layer
must translate production typed Core into this syntax and validate stable
binding and effect identities.

Typing, coverage, refinement evidence, ownership, handler reduction under
arbitrary evaluation contexts, preservation, one-step progress, divergence, and
compiler-pass simulation remain outside the checked package. Handler clauses
receive the captured one-shot continuation at a direct operation redex, but the
model does not yet prove that captured linear obligations are discharged.

Run `lake build` from this directory.
