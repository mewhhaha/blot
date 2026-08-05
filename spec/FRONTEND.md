# Frontend and elaboration

## 1. Contract

The frontend is the composition

```text
F = elaborate o fixityFold o materialize o parse o lex
```

from exact source text to Blot AST. Baba owns `lex` and `parse`; Blot owns
materialization, fixity folding, and elaboration. Compiler commands use Baba's
CPU compact frontend. The WebGPU executor is a conformance tool, not a fallback
source of syntax.

For source `s`, successful frontend execution produces

```text
F(s) = (a, spans, imports, includes)
```

where every node in `a` has a source origin, and every external input that can
affect later compile-time evaluation appears in `imports` or `includes`.

## 2. Lexing and parsing

The generated Baba plan and its schema version are part of the compiler input.
The grammar must satisfy the version-3 general profile and declare every rule as
an island. No `metadata.parser.resolutions` entry may choose between ambiguous
meanings.

Required properties:

```text
lex(s) = t1 and lex(s) = t2       implies t1 = t2
parse(t) = c1 and parse(t) = c2   implies c1 = c2
```

Compact-CST materialization preserves rule identity, field identity, token
identity, ordering, and source spans. Unknown schema identities are invariant
failures. Rejected source receives a diagnostic at the furthest justified source
span; the materializer does not invent a partial AST to continue.

### Active-island lemma

For fixed tokens and delimiter matches, an island call is identified by
`(island, start, limit)`. Rejecting a call whose identity already occurs on the
current derivation path prevents recursive cycles. Once that call returns, its
identity cannot affect a sibling derivation and may be removed:

```text
k notin active    parse(k, active union {k}) = r
------------------------------------------------
parse(k, active) = r and active is restored
```

Therefore cycle detection needs one mutable stack, not a copy per recursive
call. At recursion depth `D`, path storage is `O(D)` and each call performs one
push and pop. Membership is a bounded linear scan of that path; replacing it
with a hash table is justified only if measured syntax depth makes that scan
dominant. The optimization changes neither candidate selection nor the
furthest-progress diagnostic.

## 3. Fixity

The grammar emits flat operator chains. A fixity environment maps operator
spellings to declarations that contain precedence, associativity, and a binding
path. Folding is deterministic for a fixed lexical environment:

```text
Gamma_f |- chain => e1    Gamma_f |- chain => e2
------------------------------------------------
e1 = e2
```

An undeclared operator or incompatible chain is diagnosed. Operator spelling has
no intrinsic semantic meaning; the path in the declaration resolves the ordinary
binding used by the folded application.

## 4. Surface elaboration

Surface forms translate to the smaller AST described by
[`LANGUAGE.md`](../LANGUAGE.md). In particular, loops become recursion and
cases, statement control becomes compiler-local result constructors, element
syntax becomes ordinary applications, and sequencing `x <- e` remains explicit
sequencing of the already-applied expression `e`.

Write `surface(s) ⇓ a` for elaboration and `~` for observational equivalence in
the source semantics. Every translation has the obligation

```text
surfaceForm ~ desugaredAST
```

under the same lexical bindings and control targets. Unspellable compiler-local
constructors must be fresh with respect to every source name. A surface feature
that can be expressed by this translation does not receive a downstream AST
node, typing rule, or backend operation.

## 5. Scope and source order

Nothing is implicitly in scope. Imports, `open`, fixity declarations, and local
bindings determine lexical lookup. The prelude is an ordinary imported module.

Elaboration preserves the source order of live computation bindings. Pure
bindings may later be erased when unused, but the frontend does not reorder a
computation or turn `let` into sequencing. A control translation must preserve
the nearest enclosing `for` and module-or-explicit-`do` return targets.

## 6. Frontend theorem obligation

If `F(s) = a`, then:

1. `a` is well scoped or carries complete scope diagnostics;
2. each AST node maps to an exact source origin;
3. evaluating `s` by the surface rules is observationally equivalent to
   evaluating `a`;
4. every imported or included input is in the source graph; and
5. rerunning `F` with the same source and parser plan produces equal AST and
   diagnostics.

CPU/GPU token parity, compact-CST corpus tests, lowering goldens, and
surface/core differential tests are executable evidence for this obligation.
