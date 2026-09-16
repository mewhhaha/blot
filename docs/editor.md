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
formats documents, and publishes style lints with quick fixes. Compiler-backed
features consume the resident Rust frontend's canonical compact syntax snapshot,
so they share the accepted editor revision. Source navigation can also use the
syntax-only Baba parser when an imported dependency cannot be loaded. Production
compiler conformance uses the downloaded CI-built compiler Wasm; the server
hosts that Rust/Wasm compiler with Baba's CPU frontend and does not initialize
WebGPU. Run it outside Helix with:

```bash
just lsp
```

Go-to-definition on an import's quoted path opens the referenced file at its
beginning. Relative and absolute paths, `blot:` modules, and package source
exports are supported. Open unsaved target files are navigable, and navigation
does not require either module to type-check. Package imports navigate to their
declared source export when that source is available, including packages that
also ship a compiled capsule.

Go-to-definition resolves local bindings, lambda parameters, case patterns,
rebindings, signature headers, source-declared shape fields, and their
shadowing. An explicit source import field and a name from an `open import`
follow the compiler's resolved source path and canonical export shape to the
exported binding. Go-to-type-definition follows the ordinary value references in
a binding's explicit signature; a compound signature may therefore lead to more
than one source-defined type value. An inferred structural type has no erased
alias to recover and remains non-navigable. Exported names inside package
capsules, generated names, compiler-provided attached members, and dynamic
record fields without a stable source location remain non-navigable.

The LSP also publishes local references and safe local rename, workspace symbols
for open documents, local-name/field/constructor completion, inferred signature
help, current surface-keyword completion, and inferred types beside explicit `_`
holes in signature values. Inline hints are capped at 60 characters, including
the `:` prefix and any truncation ellipsis. Truncation preserves Unicode
characters, and a shortened hint keeps its complete inferred type in the
tooltip. Values without signatures offer a code action that inserts a matching
`let`, `let rec`, `const`, or `const rec` header with a hole; a header whose
kind, recursion marker, or name disagrees with its following binding offers an
action that corrects the header without changing its type value. Ordinary
inferred values stay free of inlay annotations. Rename refuses invalid
identifiers and does not claim that a generated or dynamic name has a stable
source location. These features use the same resident analysis and syntax
revision as diagnostics and hover.

LSP requests run through a coordinator with two lanes. Text synchronization
applies immediately in received order, while requests flow into the syntax lane
(formatting only — the one request that never touches the compiler) or the
semantic lane (every other request and diagnostics), one active job per worker
host. Formatting carries a deadline, diagnostics keep one latest debounced job
per document, and shutdown drains the lanes before exit. `$/cancelRequest`
settles a pending request as cancelled; a newer document revision settles
in-flight work as content-modified instead of answering against stale text.
Overload, crashes, and backend failures settle documented errors rather than
hanging or returning silent empty results. A cancellation arriving after
completion is ignored and cannot cancel a later request reusing that ID.

The shipped entries run worker-backed: one thread per lane, so analysis blocks
only its own thread and formatting never waits on the compiler. Deno workers
through `src/deno/lsp_worker_host.ts` and Node worker threads through
`src/node/lsp_worker_host.ts`, with the syntax and semantic worker entries
beside them under `src/lsp/workers/`. Workers run one job at a time per thread;
the semantic worker owns its compiler replica, and document synchronization
reaches it through priority lane jobs, so the replica never serves a revision
the coordinator has moved past. The syntax worker is compiler-free by
construction: format jobs carry their own text and need no service replica. A
worker that fails to boot rejects loudly through the lane startup path; there is
no silent inline fallback. Inline hosts remain for tests and embedders that
inject their own lanes.

Closing a document invalidates its pending requests, drops its lane work,
releases its root, and clears its overlay and diagnostics. Shared dependencies
remain resident while another open root reaches them, and closing a standalone
unsaved document does not require a file on disk.

The server advertises incremental text sync with open/close and save
notifications, definition, type definition, references, rename, hover,
completion (`.` and `#` triggers), signature help, inlay hints, document and
workspace symbols, document formatting, and resolving code actions (`quickfix`,
`refactor.rewrite`, `source.fixAll.blot`).

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
indentation and targets 80-column lines. It spaces operators, declaration
delimiters, calls, and collection members consistently, while keeping
projections and prefix qualifiers tight. `case` arms and statement `if` suites
stay vertical. Closing delimiters align with their opening scope, including
returned records. A binding or `return` value moves to a two-space continuation
when the complete line is too wide. Multiline delimited values move as a unit
before their contents are laid out, so a declaration prefix cannot select a
different delimiter shape. Lambdas expand according to their scope when needed.
Arrays stay on one line when the complete expression fits within its value
scope; otherwise every element gets its own line. Long tuple arguments likewise
expand when that removes an overlong line. It also removes trailing whitespace,
writes LF line endings, leaves one final newline, and removes parentheses made
redundant by postfix precedence or left-associative application while retaining
groupings that affect the AST. Comments remain source text in the gaps between
Baba CST nodes, so formatting cannot discard them.

The style is fixed: 80 columns, two-space indentation, LF line endings, one
final newline. Formatting options are validated — mistyped values fail the
request as invalid params — but never override the house style. Every repository
formatting path (the `fmt` CLI, the repo format scripts, and the LSP request)
runs the one `formatSource` engine with identical style resolution, and a parity
test proves the CLI and the LSP emit identical bytes for the same input. Use it
from the command line with:

```bash
just format source.blot
just format-check source.blot
just lint-check source.blot
just lint-fix source.blot
```

The formatter runs a fixed-cost pipeline: one buffer snapshot feeds a typed
formatting IR, the IR prints through a document algebra, and changed output is
validated with exactly one output parse. There is no rewrite/reparse loop —
layout decisions compose bottom-up, and no production helper invokes the
frontend. Changed output costs at most two frontend invocations (one when the
caller supplies a matching snapshot); unchanged output returns without an output
parse. Validation is a typed invariant failure, never unvalidated changed text:
the printed output must lower to the same representation as the input, modulo
spans, empty-block collapse, and compiler-minted name suffixes. The corpus proof
formats every accepted file under `examples/`, `case-studies/`, and
`src/prelude/` twice and requires byte-stability plus representation equality;
generated round-trip properties cover idempotence, snapshot-independence, and
trivia preservation.

Snapshots and caches are content-keyed. A buffer snapshot carries its source
bytes plus a frontend revision key, so a stale or foreign snapshot parses fresh
instead of serving wrong results. The language service keeps one cache per open
document plus a workspace epoch and dependency closure, so a stale request can
never regress a newer revision. Lint detection runs against staged overlays
without loading; quick-fix candidates validate in an isolated scratch session
that leaves live diagnostics untouched, and clients without `codeAction/resolve`
receive eagerly validated edits for at most 32 deterministically ordered
candidates per request.

Performance is gated, not hoped for. `gate:editor` asserts exact frontend
invocation counts (deterministic, immune to machine speed) plus wall-clock smoke
caps with large headroom. Burst responsiveness — every request settles exactly
once while the semantic lane is held, and shutdown always settles — is proven by
deterministic scheduler tests, not by timing. The scheduled performance workflow
records wall-clock formatter and language server medians as observations; only
formatting round-trips are timed on the server side, because semantic timing
depends on compiler-cache warmth.

`lint-check` reports findings without changing the file. `lint-fix` selects
non-overlapping rewrites, checks each combined revision with the Rust compiler,
and writes the file once after the complete fix run succeeds. A failed rewrite
leaves the original file unchanged. Safe fixes may consist of several
coordinated edits. Refactors are explicitly selected and never included in
`lint-fix`. When disjoint edits conflict through scope, fix-all applies one
validated edit and recomputes the remaining suggestions. Every published
document edit carries its source version; resolving a stale action requires a
new request.

In Helix, press [`Space-a`](https://docs.helix-editor.com/lsp.html) for
individual suggestions and explicit refactors. Clients supporting
`codeAction/resolve` also see “Fix all safe Blot suggestions” and actions for
all occurrences of the selected rule. Their edits are calculated only when
selected. The server honors `context.only`, including `source.fixAll.blot`, and
also returns immediate edits to clients requesting source actions without
resolve support. The installed language configuration formats on save through
the LSP; `:format` runs it explicitly. Set `auto-format = false` in the managed
language block to opt out of format on save.

The additional idiom rules are:

| Rule                        | Suggested action                                                         | Kind     |
| --------------------------- | ------------------------------------------------------------------------ | -------- |
| `field-shorthand`           | Write `.name;` for `.name = name;`, including patterns                   | Fix      |
| `projection-destructuring`  | Combine adjacent projections from one record                             | Fix      |
| `parameter-destructuring`   | Move an immediate destructuring binding into a strict parameter          | Fix      |
| `terminal-value-forwarding` | Return the final temporary's expression directly                         | Fix      |
| `public-primitive`          | Use the public name of the exact same primitive                          | Fix      |
| `identity-handler-return`   | Remove an identity `.return` clause from a handler literal               | Fix      |
| `selective-open`            | Bind the few fields actually used by an `open`                           | Fix      |
| `local-open`                | Move an `open` used by one function into its body                        | Refactor |
| `identity-variant-case`     | Return the subject of a constructor-preserving match                     | Fix      |
| `forwarding-callback`       | Pass a strict function directly instead of forwarding through a callback | Fix      |
| `handler-pipeline`          | Compose nested handlers in their original order                          | Refactor |
| `terminal-continue`         | Remove a final `continue` from a nonempty loop body                      | Fix      |
| `filtering-loop-pattern`    | Replace a first guard that only skips failures with `for case`           | Fix      |
| `iterator-loop`             | Write a canonical iterator-consuming recursion as `for`                  | Refactor |
| `accumulator-fold`          | Write a simple array fold over an already-bound array as `for`           | Refactor |
| `variant-map`               | Use `Option.map`, `Result.map`, or `Result.map_error`                    | Fix      |
| `variant-chaining`          | Use `Option.and_then` or `Result.and_then`                               | Fix      |
| `variant-fallback`          | Use the appropriate `unwrap_or_else`, retaining deferred fallback demand | Fix      |
| `complementary-filters`     | Partition once when both filters use a proved total integer predicate    | Refactor |
| `array-find`                | Replace a first-match array loop with `Array.find`                       | Refactor |

These rules deliberately have narrow premises. An unknown library identity,
changed checked interface, ownership conflict, deferred capture, or lost comment
withholds an action. A successful type check alone does not prove a rewrite
preserves evaluation. Generative effect identities that cannot be compared also
withhold interface-sensitive actions.

The highlighting fixture exercises function definitions and calls, plain and
destructured parameters, ownership/deferred qualifiers, constructors, guards,
loop control, primitives, and strings. Types remain ordinary values:
capitalization alone does not imply a type. Keyword-shaped fields such as
`.return` and `.continue` remain members. `just grammar-check` verifies the
capture positions and parser agreement; the formatter tests verify the accepted
corpus, comments, line endings, structural preservation, and idempotence.

Lints are independent rules over the lowered AST. A rule registers typed module,
declaration, expression, or pattern visitors and may also inspect the compact
CST when surface syntax matters. The runner visits each tree once for registered
callbacks, skips trees with no visitors, supplies parent and ancestor paths, and
owns reporting and source-safe fixes. AST callbacks still run before CST
callbacks, in rule-registration order.

Source-origin queries lazily build one index per lint invocation. A separate
iterative traversal records preorder positions and exclusive subtree ends, using
linear space rather than copying every descendant-name set into every ancestor.
Descendant queries binary-search the requested rule's positions and exclude the
origin itself. Equal rule names and source spans retain the union of their
concrete origins; overlapping spans alone do not establish ancestry. Selections
without concrete callbacks or source-origin queries pay no CST indexing or
traversal cost. These are syntax lookups, not new semantic facts or another
compiler pass.

The default correctness and readability rules report:

- unread pure bindings and effect results, plus unused names in parameters,
  destructuring patterns, loop patterns, and `case` patterns; no-op rebindings,
  unnecessary `rec` markers, and unreachable `case` arms;
- terminal `use name <- computation` / `return name` pairs that can return the
  computation directly, and discarded Boolean cases better written as statement
  `if` suites;
- same-type `let` shadowing better written with `:=`, exact empty values better
  written as `[]`, manual exact-record reconstruction better written with a
  spread, and unused or observed-shadowing `open` declarations;
- equality `if` chains better written as one `case`, identical branches, and
  conditionals that only reproduce a Boolean condition;
- single-return `do:` blocks and terminal `else` suites whose preceding branch
  already returns;
- discarded value conditionals better written as statement suites and
  Option-shaped terminal matches that can become `if let` guards;
- singleton `Array.append` calls inside folds, retained aliases that force a
  persistent array update to copy, singleton appends better expressed as
  `Array.push`, empty appends, and total array lookups that can become proved
  direct accesses;
- explicit calls with an active conventional infix or prefix operator spelling;
- positional parameter tuples with five or more entries, where field names would
  make calls easier to read; and
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
and effect row. Boolean, identical-branch, and array-cost rewrites likewise stay
hidden when the rewritten program changes that checked interface. Statement `if`
suites that transfer control are not treated as discarded value conditionals;
terminal suites can still collapse when both returned values make the control
flow redundant. That collapse evaluates the original condition before returning
the shared value, preserving deferred demands and traps.

Control-flow flattening follows the written CST rather than compiler-generated
return plumbing. A `do:` disappears only when its sole direct statement is a
`return`, and compound replacements retain the grouping that `do:` supplied. An
`else` is dedented only when its conditional is last in the enclosing statement
suite and the preceding branch ends in a direct `return`, so bindings cannot
leak into later source. Nested conditional ladders remain owned by the more
specific ladder rule.

Equality rewrites also require compiler facts from the accepted revision. The
checker recognizes the resolved comparison closure, so immutable aliases and
record projections retain equality semantics while a shadowed `Int.eq` spelling
does not acquire them. Conjoined comparisons collapse only when the resolved
Boolean function both has the `and` truth table and proves that its deferred
right operand is skipped or demanded on the corresponding branch. The later
check of the replacement guards the rendered edit; it is not used as a proof of
equivalence.

Effect forwarding, empty values, stable shadowing, record reconstruction, and
`open` usage likewise require readability facts from the accepted revision. The
checker certifies whether sequencing implicitly forced a computation, whether a
value is exactly empty, whether two same-frame bindings have the same closed
stable type, whether a record source has an exact ordered field set, and which
opened fields actually won name resolution. The host renders only those
certified candidates and rechecks every replacement; it does not infer these
properties from names or printed types.

Operator spelling is checked against the active source fixity overlay. Tooling
reads module declarations before offering a replacement, so overriding `+` does
not cause a named `Int.add` call to be rewritten to the wrong target. The
standard-rule test still enumerates every prelude infix and prefix target and
requires a parseable action for each.

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

The managed block points the server at
`deno run --allow-read <checkout>/src/cli.ts lsp`, keeps `auto-format = true`,
and sets no timeout override; the installer tests pin all three. An end-to-end
test spawns that exact command over stdio, drives a burst session, and proves it
settles every request, emits protocol frames only, initializes no GPU device,
invokes no native toolchain, and exits cleanly.

## Entry points, distributions, and checks

The Deno CLI (`src/cli.ts`) serves `fmt` and `lsp`; the Node CLI
(`src/node/cli.ts`, the `blot` binary) serves `format` and `lsp` with the same
engine behind them. Both formatting spellings run `formatSource` with default
controls, so bytes are identical across runtimes; both `lsp` commands run the
coordinator over stdio with the inline service.

Two distributions ship the editor runtime. The JSR package publishes the
TypeScript sources plus the generated parser plan, parser Wasm, compiler Wasm,
and prelude snapshot; it deliberately excludes tests and `src/node/`, which is
npm-only. The npm tarball ships the compiled `dist/` tree, including the worker
hosts, the Deno and Node worker entries, and the same generated inputs.
Distribution tests fail when any required path is missing, and the npm check
additionally boots a worker thread and the built `format` and `lsp` commands
from the packed, isolated install.

Run the editor suites explicitly (exact file lists, no ambient globs):

```bash
pnpm test:formatter   # formatter, properties, snapshots, text primitives, CLI/LSP parity
pnpm test:lsp         # server, soak, services, workspace, lint, installer, distributions
pnpm gate:editor      # formatter latency and invocation budgets
pnpm benchmark:formatter --only arrays-20 --samples 1
pnpm benchmark:lsp --out /tmp/lsp-bench.json
```

The same five commands exist as `deno task` entries with the same file lists;
the `pnpm test:lsp` script additionally runs the Node worker-host and Node CLI
suites, which need the Node runner. CI runs the suites and the gate on every
push, and the scheduled performance workflow records both benchmarks.

## Degradation and known limitations

Value providers degrade on broken source inputs and stay loud on broken
machinery. A check diagnostic, an unloadable module, a corrupt package capsule,
or a missing filesystem input yields degraded results — hover, signature help,
and definition answer null; completion, inlay hints, document symbols, and
references answer empty; code actions answer empty (the unreachable-statement
fallback still applies on broken buffers); and rename refuses. Anything else (a
missing compiler artifact, an invariant break) fails the request explicitly.
Formatting never degrades: it is the toolchain canary, so a broken installation
still surfaces on the next format.

Three boundaries keep HEAD behavior deliberately. Diagnostics and workspace
symbols propagate a missing-input failure instead of degrading: there is no
honest degrade target — an empty publish would clear real diagnostics without
evidence, and the project forbids synthetic span-zero diagnostics — so the
last-good publish stands and the coordinator settles an explicit error.
Attribute the failure to its import span before changing this. The eager
32-candidate validation cap has no overflow marker: over-budget candidates are
withheld in deterministic span order, and resolve-capable clients are unaffected
because they defer every candidate. And stale resolves stay asymmetric: a
single-fix resolve on a moved revision returns empty edits (the candidate may
simply be gone), while a fix-all resolve on a moved revision errors asking for
fresh actions (the whole action is void and a silent no-op would lie about an
explicit command).

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
patches one into the generated `grammar.js`, taking its keywords from Baba's
parsed `keyword` rule. Field names keep working, because `.return` matches the
reserved keyword token and `field_name` admits `keyword`.

`editor/scanner.c` supplies suite indentation and implicit record separators. It
tracks each record's first-field indentation, so nested records and `do:` field
bodies can close before the next field while more-indented projections continue
the current value. Fields on the same line still need semicolons.

`scripts/check_grammar.ts` is the reason to trust that patch rather than the
patch itself: it runs every accepted program and every syntax rejection through
both parsers and requires the expected acceptance or rejection. The compiler
side uses Blot's I64-aware Baba ingestion, matching ordinary compiler commands.
It also checks the assembled highlight query against `editor/highlights.blot`,
where statement `use` must be a keyword while `.use` remains a member.

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
