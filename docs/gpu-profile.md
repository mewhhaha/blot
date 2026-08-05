# GPU Frontend Profile

Blot's grammar targets Baba's version-3 general frontend profile. Compiler
commands execute the CPU frontend over this plan; the WebGPU implementation is
an experimental comparison target. Every grammar rule is declared as an island
so the compact CST retains every wrapper consumed by Blot's elaborator.

Regenerate and re-measure with:

```bash
deno task generate && deno task inspect
```

## Recorded counters

Measured against Baba 9.0.0. These are checked into the repository so that a
grammar change which quietly degrades parallelism shows up in a diff instead of
in a benchmark months later.

| counter                    |              blot | note                                               |
| -------------------------- | ----------------: | -------------------------------------------------- |
| `lexerStates`              |               126 | direct multiplier in the parallel DFA summary pass |
| `maxCandidateMultiplicity` |                21 | worst-case island candidates allocated per token   |
| `islandCount`              |                72 | one island for every grammar rule                  |
| `islandStates`             |               408 |                                                    |
| `islandTransitions`        |               411 |                                                    |
| `contractionRounds`        |                33 | fixed dispatch bound                               |
| `denseTransitionBytes`     |           626,688 | immutable device table                             |
| `packedBytes`              |           487,910 | version-3 runtime section                          |
| `rootLoopIsland`           | 5 (`declaration`) | root loop still proven under general throughput    |

Baba 9's generated Wasm runtime accepts only strict plans. Blot instead uses
`CpuFrontend`, which accepts the general plan and emits the compact token, node,
and edge arrays directly. Declaring all 72 rules as islands is what preserves
the full CST shape needed by source lowering.

## Historical strict-profile measurements

The measurements below record earlier syntax decisions under the Baba 7 strict
profile. They explain the source forms that remain, but they are not the current
plan counters.

Updating Baba from 8.0.0 to 9.0.0 moved strict-island analysis and compact CST
materialization into its Rust core. Blot regenerated parser plan 5 and Wasm ABI
14; the grammar-dependent version-3 general-profile counters above did not
change.

Changing elements from statements to value expressions adds one root island but
removes fifty-two island states, 39,504 dense-transition bytes, and 34,855
packed bytes. Lexer states, candidate multiplicity, contraction rounds, and
scratch factors are unchanged. Exact `<` and `>` have fixed token identities but
remain members of the infix operator rule; longer comparisons such as `<=`
remain ordinary operators. Exact `><` is reserved so an opening tag may be
immediately followed by its closing tag. `</` and `/>` are excluded from the
operator token and close paired and self-closing elements. An element body
repeats the existing bounded `statement` island, while the element's own root
island hides property expressions from the enclosing expression island. Nesting
therefore leaves no residual grammar recursion and needs no parser resolution or
contextual lexer.

Changing element properties to record-shaped `.field=value` syntax and adding
the `.field? = T` optional-field marker add one lexer state and seventy-two
island states over the first element grammar, with 74,832 more dense-transition
bytes and 88,215 more packed bytes. Candidate multiplicity, contraction rounds,
and the island count remain unchanged. Exact `?` has a dedicated token but
remains available to prefix and infix fixities through the shared operator
rules; longer operators beginning with `?` remain ordinary operator tokens.

Pinned patterns add five island states, with 4,320 more dense-transition bytes
and 3,679 more packed bytes. Lexer states, candidate multiplicity, and
contraction rounds remain unchanged. The pin keeps `#` and `(` as their existing
tokens. A combined `#(` token would make the GPU delimiter proof see a second
opener for `)`, while admitting the pattern directly as a `for` head would make
the portable parser choose between a constructor expression and a pin at `#`.
Keeping `for`'s existing expression-shaped head avoids both and needs no parser
resolution.

Updating baba from 7.9.0 to 7.10.0 changed no counter at all — `lexerStates`,
`islandStates`, `denseTransitionBytes`, and `packedBytes` were byte-identical
across it. Byte parity holds across all 59 corpus programs: `examples/`,
`examples/lib/`, every case study and its libraries, and the prelude.

Updating baba from 7.3.0 to 7.9.0 increased `packedBytes` by 448 bytes for the
new runtime metadata. The grammar-dependent counters did not change.

A pattern guard and a written effect row were measured together, because both
change the grammar and the profile is proved once. Together they cost eleven
island states, one island, 17,040 dense-transition bytes, and 15,976 packed
bytes; `lexerStates`, `maxCandidateMultiplicity`, and `contractionRounds` did
not move, and neither did the scratch factors for regions or candidates.

`pattern if condition => body` is free of lexer states because `if` is already a
keyword and a pattern can never end in one — no pattern form contains a keyword,
so the parser needs no lookahead to know the pattern is over. Nothing else in
the grammar knows a guard exists: CST lowering rewrites a guarded arm into a
level that decides the guard and a fall-through holding the rest, so coverage,
the evaluator, and the backend see ordinary arms.

An effect row is `{ Console, Timer }`, and it is its own separated island rather
than an alternative inside `shape`. Two islands then open on `{`, which is what
`maxCandidateMultiplicity` measures, and it stayed at 5: a row's members carry
no leading `.` where a shape's members always do, so one token after the brace
decides which island is live. Without the island declaration the grammar is
rejected outright — `effect_row` contains `expression`, which contains it back,
and an undeclared region leaves that recursion residual. Requiring a row to be
non-empty is what leaves `{}` unambiguously the empty shape.

Declaration tags use `@[descriptor]`: `@[` is disjoint from an intrinsic's
`@name`, so it costs one lexer state and ten island states while leaving
candidate multiplicity, contraction rounds, and both scratch factors at 5. Using
`#[descriptor]` was rejected after measurement because `#` also opens a
constructor and raised candidate multiplicity and the scratch factors to 6. The
tag field in the binding semantic recipe raises `maxConstraintsPerNode` from 3
to 4; dense transitions grow by 15,936 bytes and the packed plan by 12,783 bytes
in total.

`<-` cost two more lexer states and two island states. Splitting it into its own
declaration alternative was a shift/reduce conflict on IDENT against `:=`, and
the design fix was to notice that both are a name, an arrow, and a value —
`rebinding` is one rule with two arrows, and neither takes a pattern.

`for` cost three lexer states and forty-six island states on top of that, again
with the multiplicity and contraction bounds unmoved: an `end`-terminated region
is a shape the profile already had four of. The binder is spelled with a keyword
and costs no _alternative_ — `for x in src` is parsed as a value and
reclassified into a pattern once `in` follows, rather than as a branch the
parser would have to choose from the first token. `lambda` used the same trick
until `fn` paid for a real pattern there; `for` has no second keyword to spend
and needs none.

Removing the separate `loop` form reduced the profile by three lexer states,
twenty-five island states, 29,784 dense-transition bytes, and 34,237 packed
bytes. `for ever do` needs no replacement grammar: `ever` is an ordinary prelude
iterator in the existing `for source do` form. `break` remains its own
declaration and targets the nearest `for` during CST lowering.

Standalone `if` uses `then` as the boundary of its semicolon-bounded statement
body; expression `if` keeps value branches and requires `else`. Factoring the
standalone form's shared `if` opener also admits `if let pattern = value else`
without another branch opener. A bare trailing value after block statements
conflicted with the shared `IDENT` prefix of `name := ...;`, so
`do statements in value end` uses the existing `in` token as the structural
boundary instead of adding a parser resolution.

`open value;` costs one lexer state and twenty-one island states — one keyword
and one declaration alternative. A former rename/ignore mask added two rules and
sixty-six island states. Removing it, removing `do` from statement branches, and
spelling handler composition with `with` moved the current general-profile plan
from 74 to 72 islands and from 514,619 to 487,910 packed bytes. Candidate
multiplicity and contraction rounds remain fixed.

`try program with ... end` is one bounded island whose body is a repeated
semicolon-terminated handler step followed by one final step, so candidate
multiplicity and contraction rounds remain fixed. The two-argument `@handle`
spelling is parsed only inside this region and becomes the existing
three-argument primitive during CST lowering.

`fn` is the largest reduction the grammar has taken. Before it a lambda was
`postfix_expression "=>" expression`, sharing its opening tokens with an
ordinary operand so that the parser could defer the lambda-versus-expression
decision until `=>`; after it a lambda begins with a keyword nothing else begins
with. One lexer state bought the rest:

| counter                    |    before |  lambda |   final |    delta |
| -------------------------- | --------: | ------: | ------: | -------: |
| `lexerStates`              |       116 |     117 |     117 |       +1 |
| `islandCount`              |        20 |      20 |      20 |        0 |
| `islandStates`             |       865 |     794 |     618 |     −247 |
| `islandTransitions`        |     6,397 |   5,412 |   3,160 |   −3,237 |
| `maxCandidateMultiplicity` |         6 |       5 |       5 |       −1 |
| `contractionRounds`        |        33 |      33 |      33 |        0 |
| `denseTransitionBytes`     |   716,220 | 666,960 | 519,120 | −197,100 |
| `packedBytes`              | 1,061,229 | 943,339 | 645,289 | −415,940 |

`maxCandidateMultiplicity` is the one to read: it is the worst number of island
candidates allocated per token, and it fell because the two alternatives of
`value` now have disjoint FIRST sets — requirements 3 and 4 — where before a
lambda and an ordinary expression shared every operand opener.
`scratchExpansionFactors` for regions and candidates fell from 6 to 5 with it,
so the runtime allocates less per token as well as dispatching over a smaller
table.

The body is `expression` and the parameters are a repetition, not a lambda whose
body is another lambda. Those accept the same source — `fn a => fn b => e` — but
a `root`-boundary island has no closing terminal, so it cannot appear inside
itself as a placeholder, and the recursive spelling is rejected outright as
residual recursion. Folding the repetition to the right during CST lowering is
the same move `expression` makes with `fold-fixity`.

The `lambda` and `final` columns are two edits, and the second is the larger
one. `operand` was spelled as two alternatives — a bare `postfix_expression`, or
`prefix_operator+ postfix_expression` — precisely so that no empty-repetition
reduction had to be decided before the parser knew whether it was inside a
lambda parameter or an expression. With `fn` it already knows, so the rule
collapses to `prefix_operator* postfix_expression` and accepts the same
language. That alone is 176 island states, 2,252 island transitions, 147,840
dense-transition bytes, 298,050 packed bytes, and a drop in the `summaries`
scratch factor from 360 to 184.

`islandStates` and `packedBytes` rose by roughly 60% when field names were
allowed to be keywords (`field_name = IDENT | INTEGER | keyword`). That was
bought deliberately: it permanently removes the `.const` / `.type` / `.of` /
`.return` papercut, and it costs nothing on the two counters that scale device
work per token.

## How each requirement is met

The ten proofs are listed in `../baba/docs/webgpu-frontend.md`.

- **(1) Root is the parser root and the first declared island.** `program`.
- **(2) Fixed terminal identity.** No layout sensitivity, no template literals,
  no contextual keywords. This is why blot has no interpolated-text patterns:
  they cannot be lexed without contextual promotion.
- **(3) Deterministic actions.** No metadata conflict resolutions are declared;
  the grammar generates clean.
- **(4) Non-empty, lexically identifiable island FIRST sets.** Every declaration
  form opens with its own keyword or with `:=`.
- **(5) Boundary spellings resolve to one terminal each.** `;` terminates
  declarations and shape members, `end` terminates every variable-width region.
- **(6) Unambiguous opener-to-closer mapping.** `()`, `[]`, `{}` only.
- **(7) Distinct opener, closer, separator.** `[` `]` `,` for arrays and array
  patterns.
- **(8, 9) Contracted grammar is a bounded transducer with no residual
  recursion.** Expressions are flat `operand (OPERATOR operand)*` chains and
  precedence is the semantic `fold-fixity` opcode, so no precedence climbing
  appears in the grammar at all.
- **(10) Within table limits.** See the counters above.

## What the profile cost the language

The concessions are recorded here so they are not rediscovered as bugs:

- **`return expr;` is a declaration form**, not a trailing bare expression. It
  keeps the root a bounded sequence with an explicit structural boundary.
- **An expression block separates its value with `in`.** In
  `do statements in value end`, the marker distinguishes the value from another
  semicolon-terminated statement. Without it, an `IDENT` could begin either the
  value or `name := ...;`, which is an LR conflict and an unbounded GPU island.
- **`statement` duplicates `declaration`.** The two rules are identical, but
  their distinct compact-CST nodes make top-level and nested sequences explicit.
- **A lambda opens with a keyword.** `fn x => x`, not `x => x`. Requirement 4
  wants an island's FIRST set to be lexically identifiable, and a bare parameter
  shares every opener with an ordinary operand. This was once paid for the other
  way — no keyword, and currying spelled `f => (x => f (f x))` — and the keyword
  is cheaper by every counter above. `=>` is reserved for lambda parameters and
  case arms, so omitting `fn` is a syntax error.
- **A prefixed operand needs parentheses.** `consume (!token)`, not
  `consume !token`: in a flat chain a trailing operator reads as infix.
- **`_` is an ordinary name, not a literal.** It also matches `IDENT`, so a
  parser would have to choose between the two by context, and requirement 2
  forbids contextual terminal identity. Lowering treats the name `_` as a
  wildcard, which costs nothing — a binding nobody reads is what a wildcard is.
  This one was found by parity, not by generation: the LR parser accepted both
  readings and the GPU frontend did not.
- **Baba's semantic recipe checks signed 32-bit literals.** Blot's integer
  domain is signed 64-bit, so the compiler re-ingests Baba-identified wide
  integer spans with same-width zero spellings and materializes their original
  text. Baba still owns tokenization and offsets; Blot retains its I64 policy.

Two things the profile did _not_ cost, contrary to the gpu-duck reference:

- **Lambdas in shape members need no `end`.** gpu-duck required a
  `bounded_lambda` form; blot's ordinary `lambda` rule works in member position.
- **Lambda parameters are ordinary patterns.** gpu-duck shares the
  `postfix_expression` prefix with ordinary operands and reclassifies the head
  afterwards; `fn` lets blot parse a `binding_pattern` in the first place, so
  `fn { .x; } => x` and `fn !value => …` are spelled the way every other binder
  is.

## WebGPU comparison

The Baba 9 general-profile CPU frontend is the compiler authority. The WebGPU
executor can still be compared with it when an adapter is available:

```bash
just parity
```

This diagnostic compares raw tokens, nodes, edges, symbols, and types word for
word. Baba 9's general CPU and WebGPU executors can currently choose different
node orders or reject different nested-island candidates, so this comparison is
not a Blot release gate. `deno task generate`, the CPU corpus gate, lowering,
and the executable catalog are the release checks.

The corpus includes `src/prelude/*.blot`. The prelude is blot source and gets no
exemption from the compiler's CPU frontend contract.

## A float token

Adding `FLOAT = /[0-9]+\.[0-9]+/` at priority 3 moved `lexerStates` from 114 to
116 and changed nothing else: `maxCandidateMultiplicity` stayed at 6 and
`contractionRounds` at 33 under the historical strict plan. Two states is what a
token costs when it is a fixed terminal identity rather than a contextual
promotion — the digit-point-digit shape is decided by the lexer alone, with no
island having to know whether a dot begins a projection or continues a number.
