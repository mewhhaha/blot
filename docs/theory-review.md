# Theory follow-up after the core-semantics merge

## Status

This is a non-authoritative follow-up to
[`theory-coherence-review.md`](theory-coherence-review.md). The normative
contracts remain [`LANGUAGE.md`](../LANGUAGE.md) and [`spec/`](../spec/README.md).

Reviewed against `main` at
`19ddcb52f1fc0966acfd4eac101f7fd4d1985594`.

## What the merged work resolved

Pull request #52 closed several findings that were present in the earlier review:

- [`CORE_SEMANTICS.md`](../spec/CORE_SEMANTICS.md) now centralizes demand,
  semantic identities, module instances, handler rows, progress, and
  cancellation boundaries;
- [`CORRECTNESS.md`](../spec/CORRECTNESS.md) separates one-step progress from
  maximal-execution safety;
- the handler row is stated as explicit subtraction followed by clause-effect
  union, with regressions for re-performing the handled effect;
- import occurrence identity is preserved in the Rust evaluator and covered by
  Rust and TypeScript regressions; and
- the lexical demand judgment is no longer left only as informal optimizer
  prose.

Those items should not be reintroduced as parallel specifications. The remaining
work is narrower.

## 1. Make pass simulations progress-sensitive

The compiler-correctness specification still uses weak forward simulation:

```text
R(x, y)    x -> x'
-----------------------------
exists y'. y ->* y' and R(x', y')
```

This is a useful finite-step clause, but it does not by itself establish the
stated equality of observations including divergence. Because `->*` permits an
empty target path, an infinite source execution can be matched by stuttering in
one target state forever. The clause also says nothing once the source is
terminal, so it does not independently exclude target-only divergence or a new
visible target outcome.

Keep the weak clause and add four adequacy premises:

1. An empty target match strictly decreases a well-founded stuttering rank.
2. A related source return, request, or specified trap reaches a matching target
   state in finitely many administrative steps.
3. A target return, request, or specified trap is reflected by the related
   source state.
4. Requests are related extensionally: effect identity, operation, and argument
   agree, and every pair of related host responses resumes related
   continuations.

A progress-sensitive weak bisimulation is the compact alternative. Either form
rules out infinite erasure stuttering, introduced divergence, and target-only
requests or traps.

## 2. Keep applicative seal identity structural in both checkers

The value semantics defines a seal by `(public name, invariant carrier)`, but the
checker boundary still derives identity differently in the two implementations:

- TypeScript embeds `show(carrier)` in an opaque name;
- Rust bridges a sealed value by public name alone.

Presentation text is not identity, and name-only identity conflates different
carriers. The checker identity should be structural modulo alpha-renaming and
closed-type equivalence.

The conservative repair is to use a canonical structural fingerprint in both
bridges. The cleaner long-term representation is a first-class
`Seal(NameId, TypeId)` checker node with invariant subtyping:

```text
A <= B    B <= A
----------------------------- seal
Seal(name, A) <= Seal(name, B)
```

Required regressions cover reversed record insertion order, alpha-renamed
quantified carriers, repeated construction, different carriers under one name,
and agreement across both checkers and serialized interfaces.

## 3. Strengthen the Lean seed before broadening its claims

The current Lean relation still gives `define` no binding behavior, gives `bind`
no result substitution, and has no execution rules for application or handlers.
The next useful milestone is an environment or capture-avoiding substitution
semantics connecting variables, definitions, binds, functions, effect requests,
handlers, and one-shot continuations.

Each theorem should record two independent dimensions:

- **logical assurance:** exactly what syntax, rules, and observations the theorem
  covers; and
- **artifact correspondence:** which compiler artifact or translation-validation
  boundary instantiates those rules.

A fully checked theorem over a seed relation and a broad differential test offer
different evidence. Neither should be described as the other.

## Recommended PR scope

1. Add progress-sensitive adequacy premises to the compiler simulations.
2. Replace presentation-derived and name-only seal identities with one canonical
   structural identity, with Node/Rust parity regressions.
3. Add binding, application, and handler data flow to the Lean seed and state its
   production correspondence precisely.

This scope builds on the merged core-semantics work rather than duplicating it.
