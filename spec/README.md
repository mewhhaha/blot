# Specification map

Blot separates the language being compiled from the obligations of the compiler
that implements it.

| Document                                               | Authority                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| [`LANGUAGE.md`](../LANGUAGE.md)                        | Normative accepted syntax and current language behavior                |
| [`PAPER.md`](PAPER.md)                                 | Coherent target model and research direction for the language          |
| [`COMPILER.md`](COMPILER.md)                           | Compiler-wide judgments, pass contracts, and theorem dependencies      |
| [`TYPECHECKING.md`](TYPECHECKING.md)                   | Declarative subtyping, inference, staging facts, and solver invariants |
| [`PREDICATE_REFINEMENTS.md`](PREDICATE_REFINEMENTS.md) | Experimental pure predicates normalized into canonical types           |
| [`FRONTEND.md`](FRONTEND.md)                           | Source, compact-CST, fixity, and surface-elaboration contracts         |
| [`STAGING.md`](STAGING.md)                             | Compile-time evaluation, specialization, and representation closure    |
| [`SAFETY.md`](SAFETY.md)                               | Coverage, relational proofs, and ownership certificates                |
| [`RUNTIME.md`](RUNTIME.md)                             | Runtime HIR, canonical ABI lowering, and WebAssembly boundary          |
| [`CORRECTNESS.md`](CORRECTNESS.md)                     | Pass simulations and the whole-compiler correctness obligation         |
| [`INCREMENTAL.md`](INCREMENTAL.md)                     | Revision identity, invalidation, and certified cache reuse             |
| [`PACKAGES.md`](PACKAGES.md)                           | Package resolution, portable module capsules, and source fallback      |
| [`COST_MODEL.md`](COST_MODEL.md)                       | Work model, benchmark boundaries, and optimization acceptance          |

The files in this directory are specifications, not claims of mechanized proof.
Each unproved result is named as a lemma or theorem obligation. Tests provide
evidence for finite cases but do not turn an obligation into a proof.

Operational notes remain in [`docs/`](../docs/). They describe current commands,
implementation status, and measured limitations. If an operational note and a
specification disagree about meaning, the specification is the intended contract
and the disagreement must be recorded as an implementation gap.
