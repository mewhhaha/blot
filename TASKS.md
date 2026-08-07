# Remaining work

The implemented language is now substantially aligned with the model. Recursive
representations have checked SCC evidence, ownership certificates publish
complete extraction lineage, tight recursive loops become structured Runtime
HIR, and the Rust compiler admits the full executable example corpus. The work
below is what remains; capacity-bearing Stores and new surface features are not
part of this list.

## 1. Close residual runtime functions

This is the last known case where a well-typed internal program can reach a
representation refusal. The checked probe is
[`experiments/generated-code/programs/opaque_function_probe.blot`](experiments/generated-code/programs/opaque_function_probe.blot).
It currently fails during `build` with:

```text
BLOT_UNSUPPORTED_LOWERING: <function> is outside the Rust residual value calculus.
```

The probe returns one of two lambdas from a dynamic `case`, then applies the
selected function to two incompatible record widths. The lambda source set is
finite, but the Rust residual evaluator loses it at the branch join.

Implement finite closure defunctionalization at that join:

1. Normalize every reachable alternative into a stable closure-source identity
   plus its ordered runtime captures. Reuse `runtime_captures`; do not infer
   another free-variable relation in the backend.
2. Represent the joined value privately as a constructor tag whose payload is
   that alternative's capture product. This is an internal Runtime-HIR type and
   must remain refused by ABI 1.
3. At application, dispatch on the tag, project the payload, replace the old
   capture identities with the projected values using the existing environment
   replacement machinery, and specialize the selected body for the concrete
   argument representation.
4. Normalize nested choices into one finite alternative table. Do not encode the
   feature as a binary-only special case merely because the first probe has two
   arms.
5. Reject only a genuinely open source set, with the expression and inferred
   signature in the diagnostic. A closed whole-program source set must compile.

Tests must cover direct choices, branch-local captures, nested choices, mutually
different capture products, repeated calls at different record widths,
private-layout validation, ABI refusal, evaluator/Wasm agreement, and the
probe's result for both selectors. Update `spec/COMPILER.md`, `spec/RUNTIME.md`,
`spec/STAGING.md`, `spec/PAPER.md`, and `SUGGESTION.md` with the representation
and validation rule.

## 2. Construct Runtime HIR progressively

Checking and Runtime-HIR preparation still traverse overlapping semantic work.
Fuse them without moving ownership into the type lattice:

1. Give each settled residual expression a stable typed-HIR builder state.
2. Commit a final Runtime-HIR node as soon as its type, effects, representation,
   ownership permission, and safety evidence are closed.
3. Keep unresolved structural folds and specialization choices pending; they are
   not final nodes and must not acquire a fallback representation.
4. Replace formatted-type specialization keys with structural identities from
   the settled graph.
5. Consume compact ownership and safety evidence while constructing the node,
   then independently validate the completed graph.

Do not reuse a `ClosedProgram` across a source edit merely because runtime
behavior appears unchanged: source origins are observable compiler output, and
an earlier edit can shift every later span. Revision reuse must preserve exact
origin identity or rebuild the affected suffix.

Measure unchanged preparation, semantic edits, checking, Runtime-HIR
construction, emission, and peak memory independently. The change is complete
only when the artifact and all parity gates are unchanged and the measured
preparation/checking boundary improves; moving work behind a different timer is
not an optimization. Update the pass and cache contracts in `spec/COMPILER.md`,
`spec/TYPECHECKING.md`, `spec/STAGING.md`, and `spec/COST_MODEL.md`.

## 3. Move the bounded oracle onto typed Core

The production Rust/Wasm compiler is already independent of gpupaper, but the
bounded TypeScript/gpupaper conformance oracle still shares part of the source
schedule. Make typed Core its input so the oracle compares a real pass boundary:

1. Lower Core values and computations, including `define`, `bind`, handlers,
   control results, and ownership/proof markers, without consulting surface
   scheduling again.
2. Keep gpupaper bounded and independent. It must not become a compiler fallback
   or a production dependency.
3. Retain the current source-AST evaluator only as an independent observation
   model, not as input to Core lowering.

Generated source/Core evaluations, handler traces, host traces, and the complete
bounded oracle corpus must continue to agree. Update `spec/COMPILER.md`,
`spec/CORRECTNESS.md`, and the effect-sequencing row in `spec/PAPER.md`.

## 4. Mechanize the stable core

Once residual closures stop changing the core representation, mechanize the
smallest useful preservation/progress result. Include live pure bindings,
functions and finite closure choices, variants and exhaustive cases, effects and
one-shot handlers, checked signed-integer traps, structural ownership, and
proved array operations. Omit modules, parsing, reflection, SIMD, source
desugarings, and the public ABI from the first artifact.

Prove or encode:

- type preservation and classified progress, including divergence and specified
  traps;
- phase erasure for compile-time-only values;
- no double move, affine at-most-once use, and linear exact use on terminating
  exits;
- bounds safety for proved array operations; and
- simulation from validated Runtime HIR operations to the small target model.

Keep executable generation and mutation tests. The mechanization supplements
those bounded simulations; it does not replace the Rust/TypeScript parity,
artifact reproducibility, ABI, or emitted-Wasm gates.

## Handoff checks

Before each push, run:

```sh
just check
just test
```

For compiler-artifact changes, also rebuild the checked-in Rust compiler and
prelude snapshot, verify reproducibility, run the complete Rust compiler
integration suite, and confirm `verify:rust-compiler` still admits all
executable examples. Keep `LANGUAGE.md` synchronized with source semantics and
the focused compiler specifications synchronized with every pass, certificate,
cache, or Runtime-HIR contract change.
