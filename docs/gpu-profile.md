# GPU Frontend Profile

blot's grammar targets baba's version-3 WebGPU frontend profile with
`"throughput": "strict"`. This is the only external constraint on blot's syntax,
and it is deliberate: almost everything the profile forbids is also what made
the reference language large.

Regenerate and re-measure with:

```bash
deno task generate && deno task inspect
```

## Recorded counters

Measured against baba 7.9.0. These are checked into the repository so that a
grammar change which quietly degrades parallelism shows up in a diff instead of
in a benchmark months later.

| counter                    |              blot | gpu-duck | note                                               |
| -------------------------- | ----------------: | -------: | -------------------------------------------------- |
| `lexerStates`              |               114 |      175 | direct multiplier in the parallel DFA summary pass |
| `maxCandidateMultiplicity` |                 6 |        9 | worst-case island candidates allocated per token   |
| `islandCount`              |                20 |       24 |                                                    |
| `islandStates`             |               854 |        — |                                                    |
| `contractionRounds`        |                33 |        — | fixed dispatch bound                               |
| `denseTransitionBytes`     |           696,864 |        — | immutable device table                             |
| `packedBytes`              |         1,002,782 |        — | version-3 runtime section                          |
| `rootLoopIsland`           | 3 (`declaration`) |        — | strict root loop proven                            |

blot beats the gpu-duck reference on both counters that matter most for
occupancy, because it has three declaration forms where gpu-duck has six and no
type sublanguage at all.

Updating baba from 7.9.0 to 7.10.0 changed no counter at all — `lexerStates`,
`islandStates`, `denseTransitionBytes`, and `packedBytes` are byte-identical,
and byte parity still holds across all 39 corpus programs.

Updating baba from 7.3.0 to 7.9.0 increased `packedBytes` by 448 bytes for the
new runtime metadata. The grammar-dependent counters did not change.

`<-` cost two more lexer states and two island states. Splitting it into its own
declaration alternative was a shift/reduce conflict on IDENT against `:=`, and
the design fix was to notice that both are a name, an arrow, and a value —
`rebinding` is one rule with two arrows, and neither takes a pattern.

`for` cost three lexer states and forty-six island states on top of that, again
with the multiplicity and contraction bounds unmoved: an `end`-terminated region
is a shape the profile already had four of. The binder is spelled with a keyword
and costs no _alternative_ — `for x in src` is parsed as a value and
reclassified into a pattern once `in` follows, the same trick `lambda` uses,
rather than as a branch the parser would have to choose from the first token.

Removing the separate `loop` form reduced the profile by three lexer states,
twenty-five island states, 29,784 dense-transition bytes, and 34,237 packed
bytes. `for ever do` needs no replacement grammar: `ever` is an ordinary prelude
iterator in the existing `for source do` form. `break` remains its own
declaration and targets the nearest `for` during CST lowering.

Standalone `if` adds thirty-three island states without changing lexer states,
candidate multiplicity, or contraction rounds. Its `then do` branch is
semicolon-bounded control flow; expression `if` keeps value branches and now
requires `else`. Factoring the standalone form's shared `if` opener to admit
`if let pattern = value else do` adds another sixteen island states, again
without moving those three bounds. A bare trailing value after block statements
conflicted with the shared `IDENT` prefix of `name := ...;`, so
`do statements in value end` uses the existing `in` token as the structural
boundary instead of adding a parser resolution.

The original `open value;` cost one lexer state and twenty-one island states —
one keyword and one declaration alternative. Adding its `{ .source: target }`
rename/ignore mask added sixty-six island states without changing `lexerStates`,
`maxCandidateMultiplicity`, or `contractionRounds`. The mask is bounded by
braces and commas, so the additional structure increases the static table
without increasing per-token ambiguity.

`try program then do ... end` adds two lexer states, one bounded island,
forty-seven island states, 57,720 dense-transition bytes, and 62,107 packed
bytes. Its body is a repeated semicolon-terminated handler step followed by one
final step, so candidate multiplicity and contraction rounds remain fixed. The
two-argument `@handle` spelling is parsed only inside this region and becomes
the existing three-argument primitive during CST lowering.

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

- **`return expr;` is a declaration form**, not a trailing bare expression. A
  bare final expression would break the strict root loop, which requires the
  root to be one repeated island with an explicit structural boundary.
- **An expression block separates its value with `in`.** In
  `do statements in value end`, the marker distinguishes the value from another
  semicolon-terminated statement. Without it, an `IDENT` could begin either the
  value or `name := ...;`, which is an LR conflict and an unbounded GPU island.
- **`statement` duplicates `declaration`.** The two rules are identical. Strict
  throughput requires the repeated root island not be self-nesting, and blocks
  nest declarations; routing block bodies through a second rule name keeps
  `declaration` non-self-nesting. The language does not distinguish them.
- **Currying needs parentheses.** `f => (x => f (f x))`, not
  `f => x => f (f x)`. A directly recursive lambda body has no locatable
  boundary, and the flat `lambda_parameter+` alternative could not be
  disambiguated from an ordinary expression until `=>` was already consumed. In
  a language where the idiomatic multi-argument function takes one shape, this
  is a small cost. Because every character of `=>` is in the operator class, an
  unparenthesized inner lambda reaches the fixity table, so the diagnostic says
  exactly this rather than "unknown operator".
- **A prefixed operand needs parentheses.** `consume (!token)`, not
  `consume !token`: in a flat chain a trailing operator reads as infix.
- **`_` is an ordinary name, not a literal.** It also matches `IDENT`, so a
  parser would have to choose between the two by context, and requirement 2
  forbids contextual terminal identity. Lowering treats the name `_` as a
  wildcard, which costs nothing — a binding nobody reads is what a wildcard is.
  This one was found by parity, not by generation: the LR parser accepted both
  readings and the GPU frontend did not.
- **Integer literals must fit the signed 32-bit domain.** The frontend rejects
  wider ones outright, so `I64`'s bounds are computed at compile time in the
  prelude rather than spelled. Holding the prelude to the same profile is what
  surfaced this.

Two things the profile did _not_ cost, contrary to the gpu-duck reference:

- **Lambdas in shape members need no `end`.** gpu-duck required a
  `bounded_lambda` form; blot's ordinary `lambda` rule works in member position.
- **Lambda parameters are not restricted.** They share the `postfix_expression`
  prefix with ordinary operands, exactly as in gpu-duck, and semantic analysis
  reclassifies the head as a pattern.

## Parity

The GPU frontend has no automatic CPU fallback and no partial program on
failure, so byte parity against baba's `CpuFrontend` oracle is the only thing
that makes a grammar change safe:

```bash
just parity
```

Tokens, nodes, edges, symbols, and types must match word for word. A
disagreement means the grammar has drifted out of the profile even though
generation still succeeds — which has already happened once, over `_`.

The corpus includes `src/prelude/*.blot`. The prelude is blot source and gets no
exemption; parsing it only through the CPU path would have hidden the signed-i32
literal bound until some user hit it.

## A float token

Adding `FLOAT = /[0-9]+\.[0-9]+/` at priority 3 moved `lexerStates` from 114 to
116 and changed nothing else: `maxCandidateMultiplicity` stayed at 6 and
`contractionRounds` at 33, and the profile is still accepted with
`"throughput": "strict"`. Two states is what a token costs when it is a fixed
terminal identity rather than a contextual promotion — the digit-point-digit
shape is decided by the lexer alone, with no island having to know whether a
dot begins a projection or continues a number.
