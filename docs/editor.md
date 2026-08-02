# Editor Support

```bash
just install
```

That builds the Tree-sitter grammar, installs the queries, registers `.blot`,
and then runs `just grammar-check`. Helix should report six green checks:

```
Tree-sitter parser: ✓   Highlight queries: ✓   Textobject queries: ✓
Indent queries: ✓       Tags queries: ✓        Rainbow queries: ✓
```

There is no language server. Inference has landed, so what is missing is the
server rather than anything for it to report: `blot check` already produces
spans, and it initializes no WebGPU device, which is the property a server would
need.

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
to the word token. A global `reserved` set is, and `scripts/setup_helix.ts`
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
than an operator.

`queries/indents.scm` is unusually short. Every variable-width region in blot
carries an explicit terminator — the GPU profile requires a locatable boundary —
so indentation is just "indent inside each region, outdent on its terminator".
