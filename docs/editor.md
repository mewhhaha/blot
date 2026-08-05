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
revision, finds local lexical definitions, formats documents, and publishes
style lints. It runs the checked-in compiler Wasm and Baba's CPU frontend; it
does not initialize WebGPU. Run it outside Helix with:

```bash
deno task lsp
```

Go-to-definition intentionally stops at the current source module. Local
bindings, lambda parameters, case patterns, rebindings, and their shadowing are
resolved. Definitions introduced dynamically by `open`, imported module fields,
and package sources do not yet have cross-file locations.

The formatter is biased but conservative. It applies two-space structural
indentation, removes trailing whitespace, writes LF line endings, and leaves one
final newline. It also removes parentheses made redundant by postfix precedence
or left-associative application, while retaining groupings that affect the AST.
It does not otherwise reflow expressions. Comments remain source text in the
gaps between Baba CST nodes, so formatting cannot discard them. Use it from the
command line with:

```bash
deno task blot fmt source.blot
deno task blot fmt --check source.blot
```

The initial lints prefer one `case` over a chain of equality `if` branches and
remove conditionals whose branches all produce the same expression. Lints are
LSP hints, separate from compiler errors.

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
an identifier. So `let x = 1 return x;` — a missing `;` — parsed cleanly as
juxtaposition, while the wasm parser and the GPU frontend both rejected it. An
editor grammar that accepts programs the compiler refuses is an editor grammar
that lies.

Adding `word: $ => $.IDENT` is not enough; keyword extraction still falls back
to the word token, and OPERATOR can absorb structural `=` and `=>` outside their
grammar rules. A global `reserved` set fixes both, and `scripts/setup_helix.ts`
patches one into the generated `grammar.js`. Field names keep working, because
`.return` matches the reserved keyword token and `field_name` admits `keyword`.

`scripts/check_grammar.ts` is the reason to trust that patch rather than the
patch itself: it runs every accepted program and every syntax rejection through
both parsers and fails if they ever disagree.

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
`queries/elements.scm` applies the same rule to element delimiters and property
fields: exact `<` and `>` tokens are brackets inside an element but remain
operators elsewhere, while a shape field's optional `?` is punctuation rather
than an operator. `queries/calls.scm` captures the called binding in `render x`
and `draw` in `Canvas.draw x` as `function.call`; values that are only
referenced retain their ordinary variable, type, or member colour.

`queries/indents.scm` is unusually short. Every variable-width region in blot
carries an explicit terminator — the GPU profile requires a locatable boundary —
so indentation is just "indent inside each region, outdent on its terminator".
