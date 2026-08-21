# Compiler correctness obligations

## 1. Meaning of correctness

Compiler correctness is preservation of observations, including specified traps
and divergence. It is not merely equality of successful return values. For a
pass relation `R_i`, a source step may correspond to zero or more target
administrative steps:

```text
R_i(x, y)    x -> x'
-------------------------------
exists y'. y ->* y' and R_i(x', y')
```

Terminal states preserve returns, host requests, traps, and continuation use.
Divergence preservation requires that the target cannot turn an infinite source
execution into a return or unrelated trap, nor remove demanded divergence.

The finite-step clause is therefore only one part of the pass obligation. Every
pass relation also carries a **progress-sensitive adequacy package**:

1. when a source step is matched by zero target steps, a well-founded stuttering
   rank strictly decreases;
2. if a related source state is a return, host request, or specified trap, every
   maximal target execution reaches the matching visible outcome after finitely
   many administrative steps;
3. every target return, host request, or specified trap is reflected by the
   related source state; and
4. related host requests agree on effect identity, operation, and argument, and
   every pair of related host responses resumes related continuations.

Equivalently, a pass may prove a progress-sensitive weak bisimulation. Either
form prevents infinite administrative stuttering, target-only visible outcomes,
and introduced or erased divergence.

## 2. Dependency graph

```text
parse determinism
  -> elaboration simulation
  -> inference soundness
  -> coverage and relationship safety
  -> ownership safety
  -> phase safety
  -> specialization simulation
  -> Runtime-HIR simulation
  -> Core-adapter simulation
  -> Wasm simulation
  -> ABI adequacy
  -> whole-compiler observation theorem
```

The obligations are compositional only when adjacent relations agree on their
shared artifact. A pass that recomputes an earlier fact creates another relation
and another proof obligation; carrying and checking the original certificate
keeps the graph linear.

## 3. Source metatheory

The source-language obligations are:

- **one-step progress with classified outcomes:** a closed well-typed
  computation returns, takes a reduction step, requests a declared effect, or
  takes a specified trap;
- **maximal-execution safety:** every maximal execution reaches one of those
  classified outcomes or contains infinitely many reduction steps;
- **preservation:** reduction preserves result type and cannot introduce an
  unaccounted effect;
- **coverage:** an accepted closed match does not get stuck on a missing arm;
- **relationship safety:** replayed proof-required operations satisfy their
  propositions; and
- **ownership safety:** reduction does not duplicate or lose tracked
  obligations.

[`PAPER.md`](PAPER.md) defines these statements and
[`TYPECHECKING.md`](TYPECHECKING.md) gives the inference lemmas on which they
depend.

## 4. Translation proofs

Each translation needs preservation plus simulation:

| Translation                        | Relation ignores                              | Critical obligation                                      |
| ---------------------------------- | --------------------------------------------- | -------------------------------------------------------- |
| surface to AST                     | surface sugar and compiler-local control tags | scope, order, and control targets agree                  |
| staged AST to residual program     | compile-time-only values                      | erasure cannot change a demanded observation             |
| specialized program to Runtime HIR | structural polymorphism and proof terms       | every residual value has a related closed representation |
| Runtime HIR to Wasm                | administrative machine state                  | returns, requests, traps, and divergence agree           |
| private value to ABI               | private allocation identity                   | caller-visible values and ownership agree                |

Module instantiation is part of the source-to-residual simulation even when the
implementation fuses it with checking or staging. Each written import occurrence
owns one instance identity. Sharing the value produced by that instance is
permitted; merging two occurrences or replaying one occurrence for several uses
of its result is not. Generative compile-time identities allocated while an
instance evaluates are scoped by that occurrence, so a cache may reuse the
instance only under the same occurrence identity and source revision.

For a positive recursive result, the specialized-to-HIR relation is guarded by
one private indirect root. Constructing the root stores a related non-recursive
unfolding in scratch memory; loading it returns that unfolding; and every
recursive child relates through the same one-word root. This makes the Runtime
type graph finite and gives the simulation a decreasing step at each load rather
than requiring an infinite flat layout. The ABI relation has no case for this
root in ABI 1, so accepting it at a public boundary is an emitter error.

## 5. Trusted base

The current trusted base contains:

- the normative source semantics and primitive specifications;
- the generated Baba plan schema and Baba CPU frontend contract;
- compile-time input resolution;
- certificate replay and Runtime HIR validation;
- the direct Rust emitter and canonical public-layout implementation;
- the WebAssembly Core engine; and
- the caller's conformance to the declared ABI.

Tests reduce risk but are not trusted proofs. An independent checker reduces the
trusted implementation surface only when it is smaller than the producer and
reconstructs every premise from stable identities.

The executable evidence currently includes generated pure and staged arithmetic
programs evaluated both as loaded source AST and as typed Core, generated
one-shot handlers compared across the same boundary, independently replayed
relationship and ownership certificates, generated nested ownership paths with
owned-sibling mutations, complete dynamic extraction lineage with missing-part
mutations, boundary-biased checked-integer traps, generated recursive divergence
with an evaluator resource-bound witness and an isolated non-returning Wasm
call, evaluator/emitted-Wasm host traces, Runtime-HIR parity, and whole-corpus
evaluator/oracle/Wasm observations. These are bounded simulations, not
substitutes for the preservation and progress proofs above.

## 6. Evidence ladder

The implementation should advance in this order:

1. golden parse and elaboration artifacts;
2. principal-type and diagnostic parity;
3. independent coverage, relationship, and ownership certificate replay;
4. staged/unstaged differential evaluation;
5. Runtime-HIR parity between compiler implementations;
6. reference/conformance/Wasm observational parity;
7. ABI round-trip and malformed-input properties; and
8. mechanization of the smallest stable core.

`formal/lean` is an initial checked boundary, not yet a proof of the whole
language. A claim graduates from “tested invariant” to “proved lemma” only when
its formal assumptions and conclusion match the artifact contract used here.
Every mechanized claim records two independent dimensions: its **logical
assurance** (the syntax, reductions, observations, assumptions, and conclusion
that Lean checks) and its **artifact correspondence** (the production compiler
artifact or translation-validation boundary that instantiates those rules). A
strong theorem over a seed calculus and a broad differential test are different
evidence; neither substitutes for the missing correspondence argument of the
other.

Auxiliary analysis may remain outside the mechanized trusted core only through
translation validation. A producer may infer control-flow environments,
ownership summaries, or certificates; the checked boundary must reconstruct
their premises from stable identities and reject an invalid fact. Conservative
joins need a weakening lemma, and any structural-path claim needs a coherence
invariant relating the abstract path to the concrete evaluator value. This keeps
fact discovery replaceable without making its output axiomatic.

## 7. Whole-compiler theorem

The theorem in [`COMPILER.md`](COMPILER.md) follows by composing the relations
above, provided every intermediate validation succeeds and every erased fact has
already been consumed. A production compiler may fuse passes or choose another
internal layout without changing the theorem, because only the artifact
relations and observations occur in its statement.
