# Frontend and elaboration

## 1. Contract

The logical frontend is the composition

```text
F = elaborate o fixityFold o materialize o parseGeneral o layout o lexBaba
```

from exact source text to Blot AST. Baba owns lexical identities and grammar
recognition; Blot owns layout insertion, compact-CST materialization, fixity
folding, and surface elaboration. The logical composition names semantic
ownership, not the number of lexer executions in a host implementation. Compiler
commands use Baba's CPU compact frontend for the general parser profile. The
WebGPU executor is a conformance tool, not a fallback source of syntax.

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

Layout elaboration inserts `LAYOUT_NEWLINE`, `LAYOUT_INDENT`, and
`LAYOUT_DEDENT` only between Baba tokens. Delimiter nesting suspends layout, an
indent opens a suite only after a grammar introducer, and a continuation indent
after any other token remains ordinary whitespace. Every inserted offset maps
back to the exact boundary in the original source, so diagnostics and editor
locations never expose the private characters. Inconsistent dedents are source
diagnostics before parsing.

The current Node host has an explicit physical bridge because Baba's
`CpuFrontend` accepts source text rather than an already-produced token tape:

```text
lex_wasm(source) -> layout(source, tokens) -> layoutSource
lex_wasm(layoutSource) -> authoritative lexical acceptance
parse_cpu(layoutSource) -> compact CST
```

`parse_cpu` internally replays the lexer tables from the same checked-in Baba
plan before running the general-profile island executor. That replay is an API
implementation detail, not a second lexical contract. Blot must not interpret
characters or assign token identities itself. A future Baba token-tape parser
API may fuse the replay away without changing `F`.

Required properties:

```text
lex_wasm(s) = t1 and lex_wasm(s) = t2      implies t1 = t2
layout(s, t) = l1 and layout(s, t) = l2    implies l1 = l2
parse_cpu(l) = c1 and parse_cpu(l) = c2    implies c1 = c2
tokens_cpu(l) = tokens_wasm(l)
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
syntax becomes a nullary effect value around an ordinary application, and
sequencing `x <- e` executes `e`. When `e` has the erased effect-value shape
`Unit -> A ~ E`, sequencing supplies `()` and binds the resulting `A`. Each
element child is an effect value in the array passed to the parent application.
A nested element and a braced existing effect value enter that array unchanged;
an ordinary bare child computation receives one nullary suspension. A binding
may place a lambda, element, or ordinary expression after an indented newline;
CST lowering removes that layout wrapper before lowering the value normally. A
top-level `if` after the newline remains the first statement of the existing
binding block form, avoiding a second interpretation of its branch suites. The
wrapper changes layout only and does not introduce an AST node or scope. A bare
element is a child only; ordinary statement regions require explicit sequencing.
A `for` head remains expression-shaped until the following `in` proves it is a
pattern. During that reclassification, `^name` becomes a pinned pattern before
ordinary operator fixity is folded; this contextual interpretation does not
change the token identity or introduce a second parser path.

Recursion is declared in a binding header:

```text
let rec f = fn p => body
        |
        +-- elaborates to Binding(f, Rec(Lambda(p, body)))
```

The modifier is admitted only after `let` or `const`; `rec` is not an expression
prefix. Consequently `f = rec (fn p => body)` fails parsing rather than reaching
elaboration. The translation deliberately retains the existing `Rec` AST so
scope construction, recursive-group typing, ownership transfer, evaluation,
specialization, and Runtime HIR receive the same representation as before. A
surface binding modifier therefore does not add a downstream declaration kind
or runtime operation.

Adjacent recursive bindings of one declaration kind elaborate to adjacent
bindings whose values have `Rec` roots. Group discovery remains an AST property
and signatures neither join nor interrupt a group. A declaration tag wraps the
already-recursive raw binding before applying its transforms, preserving the
existing rule that the transformed outer binding is not itself a group member.

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
the nearest enclosing `for` and module-or-explicit-block return targets, while
isolating both at value-producing `if` and `case` result scopes.

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
