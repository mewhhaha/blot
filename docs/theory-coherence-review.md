# Blot theory coherence review

## Status

This is a design review, not a language or compiler specification. The
normative contracts remain [`LANGUAGE.md`](../LANGUAGE.md) and the documents in
[`spec/`](../spec/README.md).

Reviewed against `main` at
`34a2e74649eadd95c4ed125d34f42f57b0bf94ea`.

## Intent as understood

Blot is trying to keep a small surface language while assigning each difficult
property to one explicit compiler judgment:

- Baba owns deterministic concrete syntax; Blot owns elaboration and meaning.
- Compile-time values provide types, effects, fixities, and layouts without a
  second source language.
- Rank-1 algebraic subtyping supplies principal ordinary types.
- Relationships between particular values live in `Phi`, outside the type
  lattice.
- Ownership and linearity live in `Omega`, outside subtyping.
- Immutable source operations may reuse storage only after separately checked
  uniqueness evidence.
- Staging erases compile-time-only values, and specialization closes physical
  representation before Runtime HIR and the public ABI.
- Later phases consume checked facts rather than recreating earlier analyses.

That separation is the strongest part of the design. It prevents relational
reasoning from becoming accidental dependent typing, prevents ownership from
complicating principal inference, and gives the compiler a plausible sequence
of independently checkable boundaries.

The distinction between [`LANGUAGE.md`](../LANGUAGE.md) as the implemented
contract and [`spec/PAPER.md`](../spec/PAPER.md) as the coherent target model is
also valuable. An implementation gap can remain visible without silently
weakening the model to match it.

## Findings

### 1. Module definitions and module instances need separate identities

[`spec/PAPER.md`](../spec/PAPER.md) currently describes a module as a unary
function and says that import resolves and returns that function without
invoking it. The implemented language and
[`spec/COMPILER.md`](../spec/COMPILER.md) instead give each written import
expression one module instance: it supplies unit or the explicit argument,
evaluates the instance's top-level declarations once, and returns the instance
result.

This is observable rather than editorial. It determines:

- the order and multiplicity of top-level requests, traps, and divergence;
- whether aliasing or projecting a module result can replay initialization;
- whether two equal-looking import expressions denote the same instance; and
- whether generative effects allocated by two instances have distinct
  identities.

A useful formal distinction is:

```text
ModuleDef(m)                         resolved module definition
ImportOccurrence(o, m, argument)    one written instantiation site
ModuleInstance(o)                   evaluation owned by that occurrence
```

The source graph should retain `o` through checking and staging. Specialization
may inline `ModuleInstance(o)`, but it must not merge two distinct occurrences
or evaluate one occurrence independently for several uses of its result.
Aliasing the result may share it; duplicating the occurrence may not.

This identity should also appear in the incremental-compilation contract.
Caching a definition is different from caching one instance's evaluated result,
especially when evaluation allocates a generative effect atom.

### 2. The handler effect-row rule is underdetermined

The handler rule in [`spec/PAPER.md`](../spec/PAPER.md) factors the computation
row as `epsilon union {ell}` and returns `epsilon union epsilon_h`.

For finite sets, that factorization is not unique: `epsilon` may already contain
`ell`. The same premise can therefore produce different result rows depending
on which `epsilon` is chosen.

State the elimination directly:

```text
Gamma |- c : A ! epsilon_c
Gamma |- h : Handler(ell, A, B, epsilon_h)
-----------------------------------------------------------
Gamma |- handle ell c with h
  : B ! ((epsilon_c \ {ell}) union epsilon_h)
```

The set difference is the semantic operation. If a handler clause performs
`ell` again, the label is reintroduced through `epsilon_h`.

The source contract should also decide whether handling an effect absent from
`epsilon_c` is:

1. valid and observationally redundant;
2. valid only when the handler has a relevant return transformation; or
3. a diagnostic for a statically redundant handler.

Any choice can use the subtraction rule; leaving the policy unstated makes
implementations invent it.

### 3. Divergence is not a one-step progress case

The progress statement in [`spec/PAPER.md`](../spec/PAPER.md) lists divergence
beside immediate configurations such as `return v`, a reducible term, an effect
request, or a specified trap.

In a small-step semantics, divergence is a property of a maximal execution, not
a fifth current-state form. Split the claim into two statements.

**One-step progress:** a closed, well-typed computation is a return, can step,
is poised to request an effect in its row, or is at a specified trap.

**Maximal-execution safety:** every maximal execution reaches one of those
classified terminal/request outcomes or contains infinitely many reduction
steps.

This gives the compiler theorem a cleaner divergence obligation: a translation
must not turn an infinite demanded source execution into a return or unrelated
trap, and must not erase demanded divergence.

### 4. Continuation cancellation exposes an unresolved resource model

`Continuation.cancel` consumes a suspended continuation without entering it,
even when that continuation owns linear captures. This is coherent if linear
means **unique and explicitly droppable**. It is not by itself a complete rule
for **must-use resources** whose final consumer has observable meaning.

Before linear values represent handles, locks, transactions, or similar
resources, choose one model explicitly:

1. **Unique but droppable.** Cancellation is a valid final use. Required
   finalization is represented separately, perhaps as an effect or a dedicated
   resource protocol.
2. **Must-use with cancellation evidence.** A cancellable continuation carries
   a checked summary describing how every captured obligation is finalized when
   the continuation is discarded.
3. **Must resume.** Cancellation is rejected whenever the continuation owns a
   linear obligation; the handler must resume exactly once.

The existing one-shot runtime guard proves only that the continuation is not
resumed twice. It does not prove what happened to the resources the continuation
owned.

A decisive regression should capture a linear value whose legitimate consumer
emits a visible host operation, interrupt the computation with an effect, and
cancel at that handler. The accepted trace—or the rejection—should state the
chosen model. An inert integer token cannot expose resource loss.

### 5. Liveness-erased strict evaluation needs a non-circular demand judgment

The paper's pure-binding semantics is attractive: dead pure declarations are
absent, while every live declaration evaluates once in source order. It avoids
both accidental laziness and traps in unused definitions.

The metatheory should make the liveness decision syntactic or judgmental rather
than defining it by the behavior it is meant to justify. For example:

```text
live(block-result, declaration-dependency graph) = binding identities retained
```

The dependency graph should be built after name resolution and surface
elaboration, before optimization. Its edges should include all ordinary value
uses and compile-time facts needed by retained declarations. The resulting
lemma is then:

```text
erase_dead(block) preserves every demanded return, request, trap, and divergence
```

This prevents an optimizer from declaring an expression dead because it appears
unobservable under an optimization that already erased it.

### 6. The identity vocabulary should be centralized

Several soundness arguments depend on identities that must not be conflated:

- source-expression identity;
- binding identity;
- immutable runtime value identity;
- effect atom identity;
- seal identity;
- module-definition identity;
- import-occurrence/module-instance identity;
- Store/root identity; and
- serialized revision identity.

Add one notation table to the paper or compiler specification stating where each
identity is allocated, how long it remains valid, whether it is generative or
applicative, and whether it may cross a cache, module capsule, Runtime HIR, or
ABI boundary.

This would make many existing rules shorter. For example, “do not re-evaluate
an effect declaration in a later pass” becomes an instance of a general rule:
a later pass may consume an identity allocated by its owning phase but may not
mint a replacement.

## Suggested priority

### Small and immediate

1. Replace the handler-row factorization with explicit set difference.
2. Separate one-step progress from maximal-execution divergence.
3. Align the paper's import prose with the implemented instance semantics.

These are specification repairs. They do not require a language change.

### Medium

4. Add import-occurrence identity to the formal source graph and incremental
   reuse rules.
5. Add the centralized identity table.
6. State a syntactic liveness/demand judgment and its preservation lemma.

### Radical, before resource-heavy libraries

7. Decide whether linearity means unique-and-droppable or must-use, and make
   continuation cancellation follow that decision.

## Executable probes

The following tests would turn the review into durable boundaries:

- Two written imports of the same module allocate distinct generative effect
  identities; two aliases of one imported result retain one identity.
- Selecting several fields from one imported result runs its top level once.
- A handler clause that performs the handled effect again leaves that effect in
  the resulting row.
- The chosen absent-effect handler policy has one accepted or rejected catalog
  example.
- A cancelled continuation holding a host-visible linear resource either emits
  the specified finalization trace or is rejected.
- Generated blocks containing dead traps, dead divergence, and transitive live
  dependencies agree before and after liveness erasure.

## Assessment

The theory is ambitious but not incoherent. Its most credible idea is not any
single feature; it is the refusal to make one analysis impersonate another.
Algebraic subtyping, relational evidence, ownership, staging, representation,
and ABI validation remain separate, with explicit facts crossing their
boundaries.

The main risk is now identity and observation preservation across composition:
modules, handlers, cancellation, caches, and specialization all move or erase
structure while claiming to preserve meaning. Tightening those few rules would
make the larger proof plan substantially easier to trust without adding surface
syntax or compiler machinery.
