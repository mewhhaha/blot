# Language review experiments

This directory distinguishes working prototypes from compiler acceptance
criteria. It does not claim the complete language review is implemented. The
baseline examined is `bbd33c00275189a45d22ad6c23cb231567d0d583`.

## Reproduced compiler issues

Run the opt-in probes with `node --import tsx` and the indicated file. They
assert the desired semantics and currently fail; they are deliberately not named
`.test.ts` and do not redefine wrong output as a regression contract.

`operator_coherence.repro.ts` attaches an alternative `.eq` to raw `@type.int`.
The constant comparison emits `false`; the dynamic equivalent returns `1`. The
two phases disagree. Explicit `Int.eq` does not use the replacement. Attaching
directly to already decorated `Int` rejects a duplicate, but the raw type
bypasses that protection.

The relevant audit points are operator registration/decorating in
`compiler/src/eval.rs`, selection in `compiler/src/typecheck.rs`, and
recognition in `compiler/src/recognise.rs`. Replacing last-wins lookup with
first-wins lookup alone would not establish import-order independence. Canonical
operations need a stable owner identity; alternate interpretations need an
explicit operation value or a distinct nominal wrapper. This is a proposed
contract, not the behavior delivered by this draft.

`static_captures.repro.ts` builds two getters from one lambda body, capturing
`"left"` and `"right"`. For `{ .left = 42; .right = 7; }`, emitted code returns
`84`, not `49`. Audit `ResidualFunctionIdentity` and runtime capture planning in
`compiler/src/hir.rs`: argument/result types and runtime capture types alone do
not distinguish different static environments. A correct key must account for
relevant transitive static evidence or refuse sharing. The restricted derivation
module keeps getters deferred to avoid this case; it does not repair the general
specialization cache.

## Predicate evidence and affine reasoning

The executable claims compare direct bounds checks with extracted Boolean
helpers. Direct checks work; the helper loses the relation. A future summary
should export checked true/false facts over stable parameter identities and be
invalidated with its implementation, imports, and operation evidence. Reject
opaque/effectful operations unless their operational demand and refinement
contracts have independently checked evidence. Never recognize a predicate by
spelling alone.

An affine update retains a relation, not the previous strict inequality. `i < n`
and `j = i + 1` imply `j <= n`; neither establishes `j < n`. Negative acceptance
cases must include the last iteration, overflow, changed array identity,
shadowed variables, stale imports, and redefined comparisons. A loop invariant
or fresh guard is still necessary.

Evaluation should count preserved proofs under helper extraction, aliasing,
module boundaries, and incremental edits, together with deterministic solver
work and certificate size. The draft does not add these certificates or
proof-loss diagnostics to the Rust checker.

## Numeric syntax

Full positive i64 decimal spellings already work and now have regression
coverage. Separators, exponent notation, and hexadecimal spellings remain
unimplemented. Extend Baba's token rules and both lowerers together, retaining
literal spelling until representation selection. Regenerate parser artifacts and
run the general-profile gates; do not add a host-side numeric lexer.

Acceptance boundaries include `pair.0`, `1.5`, `1e-6`, unary signs, range
operators, invalid/trailing/doubled separators, radix digits, i64 endpoints,
float overflow, and compile-time values larger than the runtime domain. Exact
internal big integers do not imply a finished arbitrary-precision source
arithmetic interface.

## Derivation

`blot:derive` is a checked scalar-field prototype and nonempty integer-product
encoder. It deliberately refuses unsupported ownership shapes. A full
ownership-aware reflection interface needs consuming extraction and rebuilding
evidence, remainder obligations, effect contracts, and explicit
private-constructor authority. It must not manufacture unrestricted lenses for
owned fields.

Compare accepted derived programs with handwritten equivalents on generated
code, compile-time work, diagnostics, and ownership rejection. Include runtime
parameters: constant-only tests missed the static-capture issue. The current
module is not a universal serializer or a soundness proof for arbitrary
derivation.

## Completion prototype

`completions.ts` recognizes source markers using Baba and checks fully
substituted programs with `Compiler.checkSource`. It accepts single-line
expressions only, verifies their parenthesis boundary, and rejects unresolved or
newly introduced holes. It preserves the actual checker's type, effect,
ownership, and compile-time requirement checks without implementing them in
TypeScript. Checking may execute normal compile-time code; it is not a sandbox
for untrusted candidates.

Native expression holes remain separate work. They need an incomplete status and
an obligation object containing the expected type, allowed effects, phase, live
ownership resources, and refinements. A hole must not masquerade as Bottom or
discharge a continuation. Production compilation must refuse unresolved holes.
Compare type-only completion with full-obligation checking; report rejection
categories, not just parsing success.

## Linearity and cancellation audit

The claim corpus verifies that an affine continuation cannot be consumed twice,
a handler cannot silently abandon a required linear continuation, an affine
handler may abort, and explicit `Continuation.cancel` is accepted. These are
existing semantics, not new asynchronous support.

Before adding asynchronous syntax, evaluate cancellation before/after each
suspension, repeated cancellation, resume-after-cancel, captured resource
cleanup, nested handlers, and exceptional host exits. This bounded audit is not
a proof that every future scheduler or host interaction is safe.

## Deferred surface work

Control-flow hovers and pipeline adapters are implemented. LSP destination
highlighting, native obligation displays, and effect-polymorphic pipeline
adapters are not. Explicit `for case` filtering is already supported and now has
a documentation claim; no competing implicit filtering syntax was added.
