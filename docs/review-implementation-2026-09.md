# Review implementation: scope and evidence

This implementation starts from `55f02bca9c9f8fa15ad162c6a46ccc7dee242cf2`. The
code-bearing commit is `786732e93812c0eac961084d70a2ef9d7a6741d3`; its complete
tree `f1cd57f88bae630b0cc87d7a269cdedc5010ae68` matches the locally tested
source tree. This note adds no source semantics.

## Implemented

- Rust safety checking expands a bounded fragment of known pure predicate
  helpers in their actual lexical environments. Extracted bounds checks work
  through imports and source-free capsules; unsupported predicates gain no
  invented evidence. `spec/SAFETY.md` states the exact boundary.
- Refactoring contracts compare evaluator and runtime-input Wasm behavior,
  inferred interfaces, product forms, qualified helpers, capsules, and
  resident/fresh revision results. A process-bounded qualification runner fails
  on timeout rather than silently skipping blocked synchronous Wasm.
- `blot pack` exposes the existing checked package builder. The npm package
  declares its generated JavaScript CLI executable. `blot explain` exposes
  compiler explanations with validated UTF-16 positions; failure reporting
  preserves source, target, limit, and invariant distinctions.
- A public synchronous scalar host adapter checks ABI/manifest agreement and
  explicit capability bindings, rejects Promise results and reentrancy, and
  copies canonical results before post-return cleanup. It deliberately does not
  implement a suspending guest ABI or an untrusted-code sandbox.
- The live-report study now has a loopback browser application with validated
  integer inputs, resident compilation, candidate startup checks, stale
  activation rejection, and last-good-instance retention after failed edits.
- Release-evidence checking ties a supplied standard CI run, its complete job
  evidence, and verified compiler bytes to one exact source commit. It is not an
  authentication mechanism, signed attestation, or automatic publisher.
- The language reference, inference guide, package contract, executable claims,
  and hosted-application documentation describe these implemented boundaries.

## Local validation

The frozen code tree passed all 95 tests in `scripts/check_abstractions.mjs`.
Two focused native predicate tests cover ten accepted/rejected source fixtures;
428 other native tests were filtered out of that focused invocation, not claimed
to have passed. Rust/Wasm production rebuilding, Rust formatting, all-target
Clippy with warnings denied, focused strict TypeScript checking, formatting/lint
checks, seven existing CLI tests, and two deterministic compiler performance
tests passed. The generated JavaScript package built and its CLI ran in plain
Node without a TypeScript loader.

The local compiler was rebuilt from the actual Rust source with Rust 1.97.1. Its
compiler-input digest is
`4b598577bbfb8914c7d1f644c8a8a612f1746e8d6afeb38d54e2901fbe9ac9a1`. Its local
source-commit metadata predates the final host/documentation edits; local
results are not substituted for final-head release evidence. The complete
standard CI and isolated pnpm consumer-package checks must be interpreted at the
PR revision on which they actually run.

Temporary offline-tool and checksum-verified patch-transport workflows were
removed from the code-bearing tree. No generated compiler binary or dependency
bundle is committed. Standard `.github/workflows/ci.yml` remains unchanged.

## Not completed

Issue #96 remains unresolved. In particular, the existing unsettled-Scratch
helper regression was reproduced as an unsupported-lowering failure; its
assertion was not weakened. There is no completed full native/engine or full
standard-CI pass claimed here.

General predicate summaries, overflow-safe affine arithmetic and loop-invariant
inference, comprehensive aggregate/qualified-operator integration repair, a
suspending host-effect ABI with resource-safe cancellation, WASI async mapping,
general ownership-aware derivation, native obligation-carrying expression holes,
and broader compiler correctness mechanization remain separate work. The
synchronous host and stale-activation protection are not substitutes for those
features. Numeric syntax additions, extra production backends, and automatic
algorithm rewrites remain deferred as recommended by the review.

The pull request is a tested partial implementation of the review, not a claim
that every recommendation has been completed. It must remain a draft until its
integration blockers and final-revision validation are explicitly resolved.
