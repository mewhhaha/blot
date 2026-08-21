# Theory implementation after the core-semantics merge

## Status

This document records the follow-up review and its implementation. The normative
contracts remain [`LANGUAGE.md`](../LANGUAGE.md) and
[`spec/`](../spec/README.md).

Reviewed and implemented on top of `main` at
`19ddcb52f1fc0966acfd4eac101f7fd4d1985594`.

## What the merged work resolved

Pull request #52 closed several findings that were present in the earlier
review:

- [`CORE_SEMANTICS.md`](../spec/CORE_SEMANTICS.md) centralizes demand, semantic
  identities, module instances, handler rows, progress, and cancellation
  boundaries;
- [`CORRECTNESS.md`](../spec/CORRECTNESS.md) separates one-step progress from
  maximal-execution safety;
- the handler row is explicit subtraction followed by clause-effect union, with
  regressions for re-performing the handled effect;
- import occurrence identity is preserved in the Rust evaluator and covered by
  Rust and TypeScript regressions; and
- the lexical demand judgment is no longer left only as informal optimizer
  prose.

This PR builds on those rules rather than restating them as another semantic
layer.

## 1. Progress-sensitive pass simulations — implemented

The compiler-correctness specification retains weak forward simulation as its
finite-step clause:

```text
R(x, y)    x -> x'
-----------------------------
exists y'. y ->* y' and R(x', y')
```

It now pairs that clause with a progress-sensitive adequacy package:

1. An empty target match strictly decreases a well-founded stuttering rank.
2. A related source return, request, or specified trap reaches the matching
   target outcome after finitely many administrative steps.
3. A target return, request, or specified trap is reflected by the related
   source state.
4. Related requests agree on effect identity, operation, and argument, and every
   related host response resumes related continuations.

A progress-sensitive weak bisimulation remains an equivalent proof shape. This
closes the gap where `->*` alone could match an infinite source execution by
stuttering in one target state forever.

## 2. Applicative seal identity — implemented in the checker boundary

A seal is identified by `(public name, invariant carrier)`. Checker identity
must therefore be structural modulo alpha-renaming and closed-type equivalence,
not presentation text and not the public name alone.

The TypeScript bridge now fingerprints the bridged carrier with the same
alpha-aware canonical fingerprint used by closed type normalization. Its
regressions cover:

- records whose fields were inserted in opposite orders;
- alpha-renamed quantified carriers;
- repeated construction of the same seal; and
- equal names with genuinely different carriers.

The production Rust checker uses the same design: a sealed value is bridged to
an opaque checker identity containing the public name plus the Rust checker's
canonical `closed_type_key` of the carrier. The representation remains internal;
no new source type form or ABI value is introduced.

The semantic rule remains invariant:

```text
A <= B    B <= A
----------------------------- seal
Seal(name, A) <= Seal(name, B)
```

There is no relation between different public names.

## 3. Lean data flow and correspondence — implemented as the next seed boundary

The Lean model now carries actual data flow rather than naming independent
computations as a bind:

- variables use hygienic names;
- `define` substitutes its value into its body;
- `bind` substitutes the first computation's result into the rest;
- function application substitutes the argument into the function body;
- handler return and direct operation redexes execute their clauses;
- a handled operation receives a captured one-shot continuation; and
- resuming substitutes the response and transitions the continuation from ready
  to spent, while cancellation spends it without entering the captured body.

The formal README separately states **logical assurance**—the syntax and local
rules Lean checks—and **artifact correspondence**—the production typed-Core
translation that still has to instantiate those rules. Typing, arbitrary handler
evaluation contexts, preservation, progress, divergence, and the translation
proof remain future theorem boundaries rather than being implied by the seed
lemmas.

## Result

The follow-up review is therefore no longer only a list of recommendations. The
PR implements its three concrete boundaries while preserving the design already
merged in #52:

- progress-sensitive compiler simulation obligations;
- canonical structural applicative seal identity; and
- data-carrying Lean Core semantics with an explicit correspondence contract.
