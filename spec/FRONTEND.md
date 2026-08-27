# Frontend contract

## Status and scope

[`grammar.baba`](../grammar.baba) decides concrete parse acceptance.
[`LANGUAGE.md`](../LANGUAGE.md) decides source behavior subject to the
corrections in [`COHERENCE.md`](COHERENCE.md). This document owns the frontend
judgments that connect UTF-8 source to hygienic Core elaboration.

The frontend consists of four distinct boundaries:

```text
UTF-8 bytes
  -> tokens
  -> Baba compact CST
  -> resolved surface AST
  -> demanded value/computation Core
```

No later pass reparses source spelling or invents another interpretation of
layout, operator grouping, binding scope, or control targets.

## 1. Source and token identity

Source is UTF-8. Lexing is deterministic under maximal munch for a fixed Baba
language plan:

```text
lex(plan, source) = tokens
```

A token records its kind, exact byte span, and source revision. Whitespace and
comments influence layout and diagnostics even when they do not become semantic
nodes. An incremental lexer may reuse a token only when every byte it examined
to decide that token is unchanged; the dependency extent may exceed the token's
accepted span.

Invalid UTF-8, invalid tokens, and indentation errors are source diagnostics.
Fuel, memory, or stack exhaustion in the compiler is a limit diagnostic and does
not establish that another implementation could not lex the same source.

## 2. Compact CST

Baba's generated parser plan is the only parser authority. For fixed plan and
token stream, accepted compact-CST structure is deterministic:

```text
parse(plan, tokens) = cst_1
parse(plan, tokens) = cst_2
--------------------------------
cst_1 = cst_2
```

Equality includes rule identity, fields, child order, accepted spans, and error
recovery decisions. A later elaborator may reject a syntactically accepted form
for a semantic reason, but it may not reinterpret the token stream through a
second parser.

Every compact node retains enough source origin to produce stable diagnostics.
Compiler-generated nodes created after parsing retain an origin pointing to the
source construct whose elaboration required them.

The resident Rust frontend owns the canonical compact snapshot. It serializes
tokens, nodes, edges, parser-execution telemetry, and an explicit old-to-new
node reuse map. Semantics, diagnostics, hover, definition, lints, and the
formatter consume that one snapshot; tooling does not invoke a second parser for
the accepted editor revision. The TypeScript Baba parser remains only as a
fresh-equivalence oracle and for validating proposed formatted or quick-fix
candidate text before publication.

## 3. Fixed operator folding

The grammar emits flat operator chains. Folding uses the generated table derived
from `compiler/language.json`. Source modules cannot add a spelling or change
its precedence or associativity.

For a fixed language-plan revision:

```text
LanguagePlan |- chain => e_1
LanguagePlan |- chain => e_2
--------------------------------
e_1 = e_2
```

Each table entry contains:

```text
(spelling, precedence, associativity, qualified binding path)
```

Folding determines grouping and inserts ordinary applications to the qualified
binding path. Lexical resolution may change the value reached by that path when
source deliberately shadows a component, but it cannot change punctuation or
grouping.

An unknown operator, a forbidden non-associative chain, or an unavailable target
binding is diagnosed. The removed `operators` header is recognized only far
enough to report `BLOT_REMOVED_OPERATOR_SECTION`; it never contributes a source
fixity environment.

The generated language-plan revision is part of frontend, incremental, package,
and artifact identities.

## 4. Explicit statement values

A function body and a `case` arm are expressions. A newline and indentation may
continue an expression, but layout alone creates no statement-valued AST node or
scope.

The only expression form that contains declarations, sequencing, statement
conditionals, loops, `break`, or `return` is:

```text
do: statement value
```

Their exact source contract is in
[`EXPLICIT_DO_BLOCKS.md`](EXPLICIT_DO_BLOCKS.md). A function with statements
writes `fn x => do:`. A case arm with statements writes `pattern => do:`.
Statement suites under `if` and `for` are internal constituents of those forms;
they cannot be used as anonymous expressions.

A surrounding `const` declaration requires its initializer, including a `do:`
block, to resolve at compile time; `let` leaves the same form at run time. Phase
is not a second block node or grammar branch.

A `return` targets the nearest module or explicit `do:` block. A statement `if`
and a loop preserve that target. A `case` arm is an expression boundary: only an
explicit block inside the arm introduces a return target, and `break` cannot
cross the case boundary to an enclosing loop.

Blot has no element syntax. Components, properties, children, and suspension are
ordinary functions, records, arrays, and nullary closures. The frontend has no
element-specific lowering path.

## 5. Contextual pattern recognition

Most pattern syntax is unambiguous in the CST. A `for` head remains
expression-shaped until `in` establishes the pattern context. At that boundary,
frontend elaboration reclassifies admitted pattern forms, including a pinned
`^name`, before fixed operator folding.

This contextual interpretation:

- retains the original token and span identity;
- does not invoke another parser;
- does not grant pattern meaning outside the documented context; and
- produces an ordinary resolved pattern consumed by later elaboration.

Refutable iteration requires `for case`; ordinary `for pattern in iterator`
requires an irrefutable pattern. This prevents a pattern edit from silently
changing iteration cardinality.

A source signature lowers to a distinct, non-binding declaration containing its
`let` or `const` kind, `rec` marker, name, and compile-time requirement. Before
checking a block, the compiler requires the next declaration to be a binding
with exactly the same kind, recursion marker, and single name. The signature
does not enter lexical scope or split an adjacent recursive group. An `_` inside
its requirement retains its source expression identity for the checker to
elaborate as a signature hole; it is not resolved as a lexical read and no
parallel type grammar is introduced.

## 6. Name resolution and hygiene

Resolution maps every source read, write, signature, control target, import, and
operator target to a stable identity in one source revision.

Compiler-generated binders inhabit an identity space disjoint from source names.
Freshness is semantic, not a printed-name convention. Alpha-renaming generated
binders cannot change observations, diagnostics attached to source origins, or
serialized certificate references.

An `open`, explicit shadow, recursive group, pattern binder, and `:=` rebind use
the scope rules in `LANGUAGE.md`. A later pass consumes resolved identities and
must not repeat lexical lookup from a printed name.

## 7. Surface elaboration

Surface elaboration lowers rich control to the smaller Core owned by
[`CORE_SEMANTICS.md`](CORE_SEMANTICS.md):

- a source value becomes a returned Core value;
- every function application becomes a Core computation;
- a pure source position admits an applied computation only after its row
  settles empty;
- `use x <- c` becomes a bind, while `use c` binds the result to a wildcard;
- sequencing a suspended nullary effect value applies it to unit once;
- loops become recursion and cases with explicit accumulator transfer;
- statement `return` and `break` become compiler-local control results before
  ordinary Core control is reconstructed;
- handler syntax becomes explicit handler Core; and
- known deferred calls retain one affine demand fact for specialization.

An application with an empty row still uses the computation schedule. The
frontend does not create a second pure-application AST based on the eventual
row.

The liveness graph is constructed after resolution and surface elaboration. Dead
pure declarations are removed from source evaluation before safety and ownership
judgments consume the demanded program.

## 8. Module occurrences

Resolution distinguishes:

```text
resolved module definition
written import occurrence
module instance under a parent occurrence stack
```

Every written import occurrence receives a stable source-site identity. Nested
instance identity includes the complete enclosing occurrence stack. Reusing a
resolved path, argument value, or printed import spelling cannot merge two
occurrences.

Bare import supplies unit; `import ... with value` supplies the explicit module
argument. Elaboration yields the evaluated instance result, not an uninvoked
module closure.

## 9. Diagnostics and recovery

Frontend recovery exists to report more source errors, not to broaden accepted
syntax. Recovered nodes carry an explicit error identity and cannot enter a
successful checked artifact.

Diagnostic ordering is deterministic for fixed source, language plan, dependency
revisions, and compiler schema. Source diagnostics are distinguished from
compiler-limit diagnostics as specified in `COHERENCE.md` and `COMPILER.md`.

## 10. Obligations

The frontend owes:

1. **lexing determinism** for a fixed plan and source revision;
2. **parse determinism** for a fixed token stream;
3. **incremental equivalence** with fresh lexing and parsing;
4. **fixed-operator determinism** and rejection of removed custom fixities;
5. **hygiene** for every generated binder;
6. **scope preservation** for reads, rebinding, recursive groups, and imports;
7. **control-target preservation** for explicit blocks, loops, cases, and
   handlers;
8. **typing preservation** from accepted surface constructs to Core;
9. **operational correspondence** up to administrative Core steps; and
10. **origin preservation** sufficient for stable source diagnostics and
    certificate references.

Executable parser, CST, and elaboration fixtures provide finite evidence for
these obligations. They do not authorize a source form absent from
`grammar.baba` or a second downstream semantics.
