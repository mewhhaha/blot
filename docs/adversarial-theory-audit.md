# Adversarial theory audit

## Status

Reviewed against `main` at `fc4febe5fe5615f957e514f57a8b312c1cd97c89` on
2026-08-24. This file records the review; it is not an independent semantic
authority. Current precedence is defined in
[`spec/README.md`](../spec/README.md), and the cross-document contract is
[`spec/COHERENCE.md`](../spec/COHERENCE.md).

## Method

The audit treated every duplicated rule as hostile input. It compared:

- the generated Baba grammar and operator plan;
- `LANGUAGE.md` and explicit-block migration rules;
- the integrated paper and each focused specification;
- executable examples and current production-target claims;
- Runtime-HIR and ABI boundaries;
- ownership/capability extensions; and
- the stable Core boundary represented by the current Lean development.

The test was not whether two paragraphs sounded compatible. For every boundary,
the audit looked for one program, proof object, cache key, caller value, or
target trace that could satisfy one rule and violate another.

## Findings

### 1. Anonymous statement bodies contradicted the grammar

The grammar admits declarations and statements as a value only through `do:`.
Older frontend and language prose still described indentation after `=>` or `=`
as an anonymous statement block, and several examples wrote statement `if`,
declarations, or `return` directly in a function body or case arm.

The corrected contract is:

- a function body and case arm are expressions;
- indentation may continue an expression but creates no block;
- statement bodies use `fn x => do:`;
- statement case arms use `pattern => do:`; and
- a surrounding `const` determines compile-time resolution; and
- statement `if` is not a value expression.

### 2. Source fixities contradicted the generated language plan

The current surface has one generated operator table. Older frontend and
incremental prose still referred to a source-provided fixity environment and to
fixities in module prefix identity.

The corrected contract makes operator spelling, precedence, and associativity
part of the generated language-plan revision. Source resolves the ordinary
qualified target binding but cannot change punctuation or grouping. The removed
`operators` section only produces its migration diagnostic.

### 3. Empty-row application had two incompatible Core meanings

The integrated paper placed application in computation syntax but also said an
empty-row application belonged to the pure fragment. The stable Core model and
actual sequencing discipline use one computation form.

Every application is now a Core computation. An empty row proves only that the
call issues no algebraic-effect request. It may still return, take a specified
trap, or diverge. A surface pure position admits the result after the row
settles empty but uses the same computation schedule.

### 4. Demand and ownership could count an erased consumer

Dead pure declarations are absent from source evaluation. Without an explicit
ordering between demand and ownership, a consuming call in a dead declaration
could appear to discharge a linear path even though the declaration never exists
operationally.

Ownership is now checked over the demanded program, or under an equivalent
erasure-preservation proof. A move, cancellation, or destructor erased with a
dead declaration cannot satisfy a linear obligation.

### 5. Staging assigned the wrong identity policy to seals

One staging document called effects and seals generative. The type and
integrated model define ordinary effects as generative but seals as applicative.

The corrected split is:

```text
ordinary effect identity
  = complete module-instance/declaration occurrence

seal identity
  = (public name, canonical closed invariant carrier)
```

Administrative reevaluation recovers one effect occurrence; another module
instance mints another atom. Equal canonical seal inputs reconstruct the same
seal across evaluations and revisions.

### 6. The generic capability algebra asserted false definedness

The capability document claimed that if either associative bracketing of a
partial composition was defined, both were. Rectangular tiles refute this: two
adjacent top tiles can compose into a full-width strip and then combine with a
bottom strip, while a single top tile combined with the bottom strip would be an
inadmissible L shape.

The generic law is now conditional result coherence:

```text
(p * q) * r defined    p * (q * r) defined
------------------------------------------------
(p * q) * r = p * (q * r)
```

Proof-tree reassociation validates the target intermediate through the family
adapter and may be refused. A family can separately prove the stronger partial-
monoid law.

### 7. Compiler limits were misclassified as source rejection

The compiler theory said every diagnostic proved a failed source judgment, while
the implementation exposes deterministic evaluation limits such as
`BLOT_EVALUATION_LIMIT`.

The compiler now distinguishes:

```text
SourceDiagnostic
LimitDiagnostic
TargetRefusal
InvariantFailure
```

Only a source diagnostic proves a language premise false. A limit diagnostic
establishes no acceptance or rejection and is not a source observation. Raising
the documented bound may allow the same source revision to finish.

### 8. ABI authority was internally inconsistent

The specification map described every file under `docs/` as operational, while
`RUNTIME.md` incorporated `docs/abi.md` as the normative byte contract.

The authority split is now explicit:

- `RUNTIME.md` owns the semantic source/Runtime-HIR/caller relation and public
  type admissibility;
- `docs/abi.md` owns exact Core Wasm ABI 2 bytes and caller ownership; and
- the `Runtime target status` section in `docs/abi.md` remains operational.

An implementation-status limitation cannot weaken a rule for an artifact the
compiler accepts.

### 9. The ABI overclaimed dynamic seal nominality

The ABI document said the manifest name prevents caller confusion. Equal raw
Core Wasm carrier bytes do not dynamically contain a seal name.

The corrected theorem is conditional on a caller that follows the declared
manifest. The name distinguishes contracts for conforming tooling and in the
semantic representation relation; byte layout alone cannot prevent a hostile
caller from passing an equal carrier under the wrong source contract.

### 10. Target traps and forward simulation were too permissive

The runtime document admitted a target trap for an "unreachable defensive
check". If a related valid state reaches that check, it is not unreachable and
creates a target-only observation.

A defensive check may remain only with proof that related valid states cannot
reach it. Reaching one is an invariant failure. Compiler correctness now
requires progress-sensitive preservation and reflection of returns, host
protocols, specified traps, and divergence; weak forward simulation alone is
insufficient because it permits infinite administrative stuttering and
target-only outcomes.

### 11. Structural map typing did not establish sortedness

`OrderedTextMap.of V` is structurally the same authority carrier as a `Slice` of
entries. The type itself cannot prove that keys are strictly increasing.

`copy` dynamically establishes `ordered(S)`, and exported map operations
preserve it. Map-result and logarithmic-cost claims are conditional on that
protocol. A raw matching unordered `Slice` remains ownership-safe and
memory-safe but is not thereby a mathematical ordered map.

### 12. Ownership wording erased the affine/linear distinction

Some theorem wording said tracked obligations were never lost. Affine values may
be discarded; linear paths require exact consuming accounting on every
terminating exit.

The corrected ownership theorem is mode-indexed. It proves no double move, no
move through a borrow, no affine duplication, and exact terminating-exit
accounting for linear paths. It does not imply resource finalization unless the
consuming operation's own contract specifies finalization.

## Counterexamples retained as regression obligations

The revised specifications call for regressions covering:

1. an empty-row call that returns, one that traps, and one that diverges;
2. an owned consumer in a live declaration versus the same syntax in a dead
   declaration;
3. two import occurrences of one effect-producing module versus an alias of one
   result;
4. two equal seal constructions versus two equal-looking ordinary effects;
5. a rectangular capability composition with only one valid bracketing;
6. a proposed reassociation whose intermediate is an L shape;
7. the same source under a low evaluation limit and a raised limit;
8. equal raw carriers under different seal manifest names;
9. a defensive internal check demonstrated unreachable from validated states;
10. an accepted ABI boundary with every required malformed-input check;
11. a structurally matching unordered Slice passed to ordered-map code; and
12. affine discard contrasted with a missing linear consuming exit.

## Remaining proof obligations

After the changes in this review, no further rule-level contradiction was found
in the authority set examined. This is not a claim of whole-compiler proof. The
remaining named obligations include:

- surface-to-Core operational correspondence;
- dead-declaration erasure and ownership compatibility;
- principal inference within the stated rank-1 open fragment;
- coverage and relationship-certificate replay;
- ownership and destructive-reuse adequacy;
- compile-time phase safety and identity coherence;
- representation closure before Runtime HIR;
- family-specific capability laws and validator agreement;
- public adapter validation and valid-value round trips;
- progress-sensitive pass composition through emitted WebAssembly; and
- checked correspondence between production artifacts and the Lean model.

A future change reopens the audit when it silently broadens one of these
conclusions, uses a weaker identity as a cache key, treats a compiler resource
refusal as a source theorem, permits a target-only observation, or relies on a
target representation to manufacture a source fact.
