# Core semantic identities and observations

## Status and scope

[`LANGUAGE.md`](../LANGUAGE.md) remains the normative description of accepted
source. This document owns the focused semantic obligations that connect source
evaluation to checking and staging when identity, demand, effects, or module
instantiation matter. [`PAPER.md`](PAPER.md) supplies the broader research model;
[`COMPILER.md`](COMPILER.md) supplies the pass graph; and
[`CORRECTNESS.md`](CORRECTNESS.md) supplies the translation theorems.

The purpose of this document is to prevent several different notions of
"same value" or "same module" from becoming interchangeable compiler cache
keys.

## 1. Identity classes

The compiler uses identities with different allocation and lifetime rules:

| Identity | Allocated by | Equality means | May cross revision/cache? |
| --- | --- | --- | --- |
| expression | frontend AST | same expression in one source revision | only through a serialized stable expression id |
| binding | elaboration/checking | same lexical binding in one source revision | only through a closed certificate |
| immutable value | refinement analysis | same runtime value origin for `Phi` | no, unless reconstructed by a certificate |
| effect atom | compile-time evaluation | same generative effect instance | only when the owning module-instance identity is preserved |
| seal | compile-time type construction | same public name and invariant carrier | yes, when both inputs are reconstructed |
| module definition | resolver | same resolved source/module artifact | yes under the ordinary revision rules |
| import occurrence | frontend/resolved source graph | same written import site in one importer revision | yes only with that importer revision |
| module instance | module evaluation | same import occurrence under the same enclosing instance stack | yes only under that complete instance identity |
| Store/root | ownership/lowering | same physical authority root | only through the corresponding ownership certificate |
| revision | incremental compiler | same complete observed compiler input | yes; this identity exists for cache reuse |

No pass may replace one identity class with another because their printable data
happen to match. In particular, a module-definition path is not a module-instance
identity and a source name is not an effect atom.

## 2. Demand and pure declarations

Liveness is a lexical graph judgment, not an observation guessed by an optimizer.
For a block with declarations `d_1 ... d_n` and result `r`, construct the
resolved dependency graph after surface elaboration. Start with the free binding
identities of `r`; walk declarations backwards, retaining a declaration when it
is semantically forced or when it defines an identity already needed, then add
that declaration's resolved reads to the needed set.

Write the resulting finite set as:

```text
live(block, result) = L
```

Pure declarations outside `L` are absent from source evaluation. Remaining
pure declarations evaluate exactly once in source order. Operational
declarations such as signatures, effect declarations, explicit shadowing, and
`open` remain forced according to their existing source rules.

The proof obligation is:

```text
erase_dead(block, L)
```

preserves every demanded return, effect request, specified trap, and divergence.
An optimization cannot justify its own liveness input by first erasing the
behavior whose absence it is trying to prove.

## 3. Module definitions, occurrences, and instances

Let `m` be a resolved module definition and `o` a written import occurrence in
an importer instance `p`.

```text
ModuleDef(m)
ImportSite(p, span, m) = o
instantiate(o, argument) = ModuleInstance(o)
```

Bare `import` supplies unit. `import ... with value` supplies the explicit
argument. Evaluation of the occurrence yields the instance result; it does not
return an uninvoked source module function.

One written occurrence owns one semantic instance in the staged source graph.
Its top-level declarations evaluate once in source order. Aliasing, projecting,
or returning the resulting value does not instantiate the module again. A
second written occurrence is a distinct instance even when its resolved module
and supplied argument are equal.

Nested instances include the complete enclosing occurrence stack in their
identity. Thus two instances of a parent module do not merge a generative effect
created by the same nested import site.

A compiler may inline an instance and erase its module shell. It may cache the
result of evaluating an instance only under the complete instance identity and
source revision. A cache keyed only by module-definition path is invalid for a
result that may contain or capture generative values.

## 4. Generative effects

For an ordinary source effect declaration evaluated in module instance `o`,
allocation is:

```text
newEffect(o, source_node, compile_time_scope, Sigma)
  => effect(ell, Sigma)
```

where `ell` is fresh with respect to every different tuple of those identity
inputs. Re-evaluating the same source node administratively during checking or
lowering must recover the recorded `ell`; evaluating the declaration in a
different module instance must not.

Aliases preserve the atom. Structural equality of operation descriptors does
not identify effects. Named compiler-private effects may use their separately
specified applicative identity rule; they are not evidence that ordinary
`@effect` is applicative.

## 5. Handler row elimination

Let the handled computation have row `epsilon_c` and let all handler clauses,
including the optional return clause, contribute row `epsilon_h`. Handling
`ell` has the rule:

```text
Gamma |- c : A ! epsilon_c
Gamma |- h : Handler(ell, A, B, epsilon_h)
-----------------------------------------------------------
Gamma |- handle ell c with h
  : B ! ((epsilon_c \ {ell}) union epsilon_h)
```

Set difference is part of the rule. Factoring the premise as
`epsilon union {ell}` without an absence side condition is insufficient because
set union is idempotent and does not determine `epsilon` uniquely.

A handler clause that performs `ell` reintroduces the label through
`epsilon_h`; the operation is not recursively swallowed by the handler whose
clause is currently running.

Handling an effect absent from `epsilon_c` is valid. Its operation clauses are
unreachable for that computation, while its return clause may still transform
the normal result. This is a checked redundant handler, not a diagnostic.

## 6. One-step progress and divergence

For a closed computation well typed at `A ! epsilon`, one-step progress says it
is exactly one of:

- `return v` for an appropriate value;
- able to take a reduction step;
- poised to request an operation whose label is in `epsilon`; or
- at a specified language trap.

It is not stuck on an unclassified internal state.

Divergence is an execution property, not another current syntactic form. The
corresponding maximal-execution theorem says that every maximal execution either
reaches one of the classified outcomes above or contains infinitely many
reduction steps.

Compiler divergence preservation is stated over those infinite executions: a
target may not turn demanded source divergence into a return or unrelated trap,
and an optimization may not erase demanded divergence.

## 7. Continuation cancellation boundary

The implemented language currently permits explicit sequenced cancellation of a
one-shot continuation after ownership proves that the continuation binding is
consumed. That rule proves uniqueness of continuation use. It does not, by
itself, decide whether every linear value captured by the continuation has an
observable finalization obligation.

Before linear values are used as must-finalize host resources, the language must
choose and specify one of these extensions:

1. linear means unique but explicitly droppable, with required finalization
   represented separately;
2. cancellation carries a checked summary that finalizes every captured
   must-use obligation; or
3. a continuation with a must-use capture cannot be cancelled and must resume
   exactly once.

Until such a resource class exists, this remains a design boundary rather than a
silent strengthening of the current source language.

## 8. Executable obligations

The maintained regressions for this boundary must establish at least:

- two written imports of one effect-producing module yield distinct effect
  identities;
- an alias of one imported effect preserves that identity;
- the same nested import site in two parent instances remains distinct;
- a handler clause may reintroduce the effect it discharges, and the resulting
  row exposes that label;
- handling an absent effect is accepted and a return clause may transform the
  result; and
- repeated compiler evaluation of one import occurrence recovers the same
  generative atom rather than minting a second one.

The Rust evaluator carries the import-occurrence stack in the identity used by
ordinary effect allocation. The TypeScript checker/evaluator already evaluates
written import occurrences independently and refuses reusable checked-leaf
state that contains a generative brand. Both implementations remain subject to
the same rules above.
