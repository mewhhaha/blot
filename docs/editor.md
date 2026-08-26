# Editor Support

```bash
just install
```

That builds the Tree-sitter grammar, installs the queries, registers `.blot` and
the Blot language server, and then runs `just grammar-check`. Helix should
report six green checks:

```
Tree-sitter parser: ✓   Highlight queries: ✓   Textobject queries: ✓
Indent queries: ✓       Tags queries: ✓        Rainbow queries: ✓
```

The server publishes syntax and compiler diagnostics for the open editor
revision, finds local lexical definitions, describes values and syntax on hover,
formats documents, and publishes style lints with quick fixes. All of those
features consume the resident Rust frontend's canonical compact syntax snapshot,
so the accepted editor revision is parsed once. Production compiler conformance
uses the downloaded CI-built compiler Wasm; the server hosts that Rust/Wasm
compiler with Baba's CPU frontend and does not initialize WebGPU. Run it outside
Helix with:

```bash
just lsp
```

Go-to-definition resolves local bindings, lambda parameters, case patterns,
rebindings, and their shadowing. An explicit source import field and a name from
an `open import` follow the compiler's resolved source path and canonical export
shape to the exported binding. Package capsules, generated names, and dynamic
record fields without a stable source location remain non-navigable.

The LSP also publishes local references and safe local rename, workspace symbols
for open documents, local-name/field/constructor completion, inferred signature
help, current surface-keyword completion, and selective top-level type,
specialization, and target-status inlay hints. Rename refuses invalid
identifiers and does not claim that a generated or dynamic name has a stable
source location. These features use the same resident analysis and syntax
revision as diagnostics and hover.

LSP requests run through an explicit host queue. `$/cancelRequest` removes work
that has not reached the compiler; cancellation or a newer document revision
marks an in-flight synchronous Wasm result stale and discards it. The compiler
does not yet run in a terminable worker, so this is not preemptive interruption
of a Wasm call.

Hover is broader than definition lookup. A value hover shows its full inferred
signature and, for a source-local binding, the declaration that introduced it.
Function bodies are written as the placeholder `body` after their parameters, so
a large implementation does not hide the signature. Consecutive `//` comments
immediately above the declaration are included as documentation; `///` is
accepted as the documentation-oriented spelling without introducing another
comment token. Imported values and fields still show their inferred signature
even when no local definition location is available. Hover inference is cached
for the open document version. A shape field definition describes the selected
field rather than the expression on its right. An attached member projection
uses its qualified name and includes its compact local definition; an attached
function shows its inferred arrow just like an ordinary callable field.

Every concrete syntax token also has a fallback description. Keywords explain
their control or binding role, delimiters explain the structure they open or
close, literals explain their domain, and operators show their active
associativity and precedence. An operator also names the related value its
fixity resolves to and shows a short surface-syntax example. Operators with both
prefix and infix forms show both relationships. Those descriptions remain
available when an incomplete program cannot yet be inferred.

The formatter is biased but conservative. It applies two-space structural
indentation and targets 80-column lines. Value conditionals always use vertical
`if condition:` / `else:` branches, with an explicit `return` for every branch
result. If that conditional is the scope's terminal result, the branch returns
make an outer `return if` redundant, so the formatter writes the conditional as
a statement. A binding or `return` value moves to a two-space continuation when
the complete line is too wide. Multiline delimited values move as a unit before
their contents are laid out, so a declaration prefix cannot select a different
delimiter shape. Lambdas expand according to their scope when needed. Arrays
stay on one line when the complete expression fits within its value scope;
otherwise every element gets its own line. Long tuple arguments likewise expand
when that removes an overlong line. It also removes trailing whitespace, writes
LF line endings, leaves one final newline, and removes parentheses made
redundant by postfix precedence or left-associative application while retaining
groupings that affect the AST. Comments remain source text in the gaps between
Baba CST nodes, so formatting cannot discard them. Use it from the command line
with:

```bash
just format source.blot
just format-check source.blot
```

Lints are independent rules over the lowered AST. A rule registers typed module,
declaration, expression, or pattern visitors and may also inspect the compact
CST when surface syntax matters. The runner traverses each tree once, supplies
parent and ancestor paths, and owns reporting and source-safe fixes; adding a
rule does not add another recursive compiler pass.

The default correctness and readability rules report:

- unread pure bindings, unread effect results, no-op rebindings, and unreachable
  `case` arms;
- equality `if` chains better written as one `case`, identical branches, and
  conditionals that only reproduce a Boolean condition;
- discarded value conditionals better written as statement suites and
  Option-shaped terminal matches that can become `if let` guards;
- singleton `Array.append` calls inside folds, retained aliases that force a
  persistent array update to copy, and total array lookups that can become
  proved direct accesses;
- explicit calls with an active conventional infix or prefix operator spelling;
  and
- functions whose Rust checker reports several runtime representations,
  including the compiler-confirmed keys and call sites. This is not a syntax
  estimate of direct calls.

Hover appends a concise provenance explanation when the checker has a type,
ownership, specialization, or target-preflight reason at the selected span.

Warnings identify likely correctness or cost problems; hints describe clearer
equivalent source or optimization information. Safe local rewrites appear in the
editor's code-action menu. Rewrites that need compiler evidence are different:
the server checks the rewritten open-document revision. It only publishes a
direct array access when that check supplies the required bounds proof, and it
only calls a self-rebinding a no-op when removing it preserves the public type
and effect row. Statement `if` suites remain control flow rather than value
conditionals and do not receive value-conditional rules.

Operator spelling is checked against the complete fixed operator table. The
default-rule test enumerates every infix and prefix target, including function
arrows, effect rows, numeric and comparison operations, set algebra, and
ownership prefixes, and requires a parseable action for each.

Effects and structural interfaces need no parallel lint AST. An effect, its
written row, and `Empty`, `Length`, `Semigroup`, or `Monoid` are ordinary
expressions, so the same expression visitor reaches all of them. Effect
declarations remain sequenced: when a `use pattern <-` result is unread, the
action removes the binding instead of deleting the effect. Interface
implementations remain explicitly scoped values. The linter does not replace a
primitive with an interface member merely because their inferred types agree,
since a same-typed shadowed member may have different behavior.

## What gets written

| path                                       | contents                                                     |
| ------------------------------------------ | ------------------------------------------------------------ |
| `tree-sitter-blot/`                        | generated grammar, rebuilt from scratch each install         |
| `~/.config/helix/runtime/grammars/blot.so` | the compiled parser                                          |
| `~/.config/helix/runtime/queries/blot/`    | highlights, indents, textobjects, tags, rainbows             |
| `~/.config/helix/languages.toml`           | one managed block, delimited by markers naming this checkout |

Re-running replaces the managed block rather than appending to it. Removing blot
from Helix means deleting that one delimited region.

## Two targets, one grammar

The editor grammar and the compiler's parser are both generated from
`grammar.baba`. They are the same grammar through different baba targets — and
the targets do not lex alike.

**Tree-sitter does not reserve keywords.** Its lexer resolves tokens by parser
state: where `IDENT` is admissible and `"return"` is not, it lexes `return` as
an identifier. So `let x = 1 return x` — two declarations without a newline —
parsed cleanly as juxtaposition, while the wasm parser and the GPU frontend both
rejected it. An editor grammar that accepts programs the compiler refuses is an
editor grammar that lies.

Adding `word: $ => $.IDENT` is not enough; keyword extraction still falls back
to the word token, and OPERATOR can absorb structural `=` and `=>` outside their
grammar rules. A global `reserved` set fixes both, and `scripts/setup_helix.ts`
patches one into the generated `grammar.js`. Field names keep working, because
`.return` matches the reserved keyword token and `field_name` admits `keyword`.

`scripts/check_grammar.ts` is the reason to trust that patch rather than the
patch itself: it runs every accepted program and every syntax rejection through
both parsers and fails if they ever disagree. It also checks the assembled
highlight query against `editor/highlights.blot`, where statement `use` must be
a keyword while `.use` remains a member.

```bash
just grammar-check
```

## Queries

`queries/*.scm` are hand-written and layered on top of what baba generates.

baba's metadata emits highlight captures as named-node patterns —
`(let)
@keyword` — but every blot keyword is an anonymous literal node, so those
patterns do not compile. `queries/keywords.scm` matches them by spelling, and
scopes each capture to the rule it belongs to rather than matching the bare
token. That scoping matters: blot lets field names be keywords, and a bare
`"const" @keyword` would colour `.const` too, because the token inside a
`field_name` is more deeply nested than the `(field_name)` capture and wins.
`queries/calls.scm` captures the called binding in `render x` and `draw` in
`Canvas.draw x` as `function.call`; values that are only referenced retain their
ordinary variable, type, or member colour. Exact `<` and `>` are now uniformly
operators, so editor queries need no context-specific element override.

`queries/indents.scm` is unusually short. Layout suites are explicit CST nodes,
so indentation is just "indent the suite." The generated Tree-sitter parser uses
`editor/scanner.c` to derive the same newline, indent, and dedent tokens that
the compiler derives with Baba's lexer; no private layout character is written
to a source file.
