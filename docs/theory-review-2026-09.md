# Theory review: specialization must preserve environments

## Scope and conclusion

This review starts from main revision
`4ca2337bbef0ad8662d9fdc1f76840db6f26427c`. It examines the integrated model in
`spec/PAPER.md`, the authority and correction contracts in `spec/README.md` and
`spec/COHERENCE.md`, the earlier adversarial audit, and the typing, staging,
compiler, and runtime contracts. The implementation change is deliberately
focused on residual-function identity. It is not a proof that every compiler
pass satisfies the integrated model.

The core design does not need a replacement language. Its useful separation is
between structural inference, phase checking, ownership evidence, and closed
runtime representation. The concrete mistake is treating the last of those as
enough evidence for sharing specialized code. The corrected model treats
specialization as partial evaluation of **code plus an environment**, not
monomorphization by a vector of runtime types alone.

The normative changes are in `LANGUAGE.md`, `spec/STAGING.md` section 8.1, and
`spec/COMPILER.md` section 9. This review explains those contracts; it does not
establish a competing authority.

## What remains coherent, with explicit limits

**Types as values require checked phase boundaries.** The bridge judgments in
`spec/STAGING.md` are the right restriction: a value acquires authority as a type,
effect, layout, or tag only through the corresponding checked bridge. This is
not permission for an arbitrary runtime value to choose an erased layout.

**Inference and ownership are separate obligations.** The polynomial claim in
`spec/TYPECHECKING.md` belongs to its specified open rank-1 structural fragment,
not arbitrary closed Boolean normalization, partial evaluation, specialization,
or the entire compiler. Ownership certificates cannot be reconstructed from a
runtime layout. This change neither introduces a second type checker nor moves
linearity into the subtype lattice.

**Empty effects do not imply totality or harmless reordering.** The existing
coherence corrections require preserving lexical demand, traps, divergence, and
generative identity. They must continue to constrain optimization. A residual
cache hit saves compiler work; it must not memoize the runtime result of an
effectful or divergent call.

**Generative effects and applicative seals need different identity rules.** The
existing distinction is retained. Equal-looking operation records are not enough
to merge generative occurrences. Environment evidence therefore retains recorded
creation scopes and module instances, not just displayed type names.

**Representation closure is a boundary, not an equivalence theorem.**
`closedRep(hir)` establishes that values can be represented. It does not establish
that two source computations with those representations are interchangeable.
This last distinction was not enforced by residual-function sharing.

These are architectural conclusions from the repository contracts, not newly
mechanized metatheorems. The existing formal Core development does not become a
proof of the Rust staging implementation because these tests pass.

## Counterexamples that distinguish the theories

Consider a source factory:

```blot
const make = fn name => fn value => @shape.get value name
const left = make "left"
const right = make "right"
```

For a runtime record with `.left = 42` and `.right = 7`, `left pair + right pair`
must be `49`. The historical runnable workspace at
`e60b49dac2ae5100fb3e0b5ec46b343f9ff5a060` instead emitted `84`; reversing the
encounter order emitted `14`. The omission remains visible in the reviewed
main's `ResidualFunctionIdentity`: source body, signature, layouts, and reuse
witnesses do not distinguish the two captured strings. This is wrong code, not
an inference precision tradeoff.

The same problem is not limited to static values. With
`const make = fn left => fn right => fn ignored => left - right`, construct one
closure from `(number, number + 1)` and another from the reversed pair. Their
runtime capture lists have equal types and are sorted by caller SSA identity.
Without recording which binding refers to which argument slot, both can call
the first residual body. `forward () * 10 + backward ()` then emits `-11` rather
than `-9`. A static-value-only patch would miss this second counterexample.

The committed Node tests also cover captured records, transitive closures,
combined static/dynamic captures, separate recursive factories, repeated calls,
and both the evaluator and emitted Wasm. They assert the intended results, never
the known wrong results. The historical workspace gives five wrong-code failures
and three passes in this eight-test suite; this baseline is not presented as a
run of the patched compiler.

## Replacement sharing rule

Write a specialized closure as `(code, static environment, dynamic bindings,
creation context)`. A call supplies a runtime argument and an ordered vector of
runtime captures. A reusable identity contains:

- the existing source, closed-signature, representation, and reuse evidence;
- exact static evidence reachable through the lexical free bindings, including
  captured closures, signatures, and lexical type substitutions;
- the mapping from every dynamic occurrence to its actual capture slot, with
  aliasing and runtime ownership meaning intact; and
- the complete recorded generative creation contexts.

Two keys may be equal only when specializing their bodies under corresponding
runtime arguments yields equivalent residual behavior. Equality of the key is a
conservative sufficient condition; unequal keys need not imply distinguishable
source functions. In particular, exact floating-point bits and ordered fields
avoid silently identifying distinctions the evaluator or target can observe.

The implementation constructs a tagged finite graph encoding in Rust. Repeated
closure environments become graph back-references, so recursive environments do
not require infinite unfolding. Allocation addresses detect visits during that
one traversal; they are not stored as semantic key components. Caller SSA
numbers are replaced by capture-slot numbers. This permits safe reuse after
SSA renaming without confusing a permutation or a repeated alias.

The same evidence guards recursive result placeholders. Otherwise two different
static environments could acquire one shared unresolved result identity before
either body is finished, even if ordinary function reuse were fixed.

A stateful value that the encoder cannot safely snapshot produces no key. The
call continues through the existing staging path. This check occurs before any
argument-lowering mutation. No placeholder key, printed-value hash, type-only
fallback, or target layout is accepted as substitute evidence.

## Tradeoffs and remaining obligations

The conservative key may duplicate code for environments that a more precise
semantic projection could prove equivalent. It also traverses transitive static
captures, so compiler-work and code-size gates matter. Reducing that cost should
use immutable evidence interning or a proven dependency projection, not omit
captured data merely because current examples still pass.

A full proof would relate the evidence traversal to all environment reads during
specialization, show runtime replacement preserves slot correspondence, and
establish a simulation for recursive placeholder creation and settlement. Future
`Value` variants must receive an explicit encoding or decline sharing; the
exhaustive Rust match makes that extension obligation visible. Mutable regions,
rejoin authority, continuations, and deferred demand remain outside the reusable
key rather than being assigned equality by pointer copying.

The repair does not change syntax, the Baba frontend, runtime ABI, source value
equality, the first-order compile-time result cache, or the bounded derivation
library API. It does not claim that arbitrary programs terminate during staging,
that specialization is polynomial, or that all existing research-roadmap items
are complete. Exact build and test results belong in the pull request and CI,
not in a speculative success claim in this document.

## Background

The design follows the ordinary closure distinction between code and its lexical
environment and the partial-evaluation distinction between static inputs and
dynamic parameters. Olivier Danvy's *Type-Directed Partial Evaluation* explicitly
factors dynamic free variables into a dynamic initial environment; its abstract
also states the restrictions of that system. That work motivates the separation,
not a borrowed correctness proof for Blot's effects, ownership, or staging:
[DAIMI Report Series 24(494), 1995](https://doi.org/10.7146/dpb.v24i494.7022).
