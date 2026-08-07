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

- **progress with classified outcomes:** a closed well-typed computation
  returns, steps, requests a declared effect, takes a specified trap, or
  diverges;
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
owned-sibling mutations, boundary-biased checked-integer traps, generated
recursive divergence with an evaluator resource-bound witness and an isolated
non-returning Wasm call, evaluator/emitted-Wasm host traces, Runtime-HIR parity,
and whole-corpus evaluator/oracle/Wasm observations. These are bounded
simulations, not substitutes for the preservation and progress proofs above.

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

## 7. Whole-compiler theorem

The theorem in [`COMPILER.md`](COMPILER.md) follows by composing the relations
above, provided every intermediate validation succeeds and every erased fact has
already been consumed. A production compiler may fuse passes or choose another
internal layout without changing the theorem, because only the artifact
relations and observations occur in its statement.
