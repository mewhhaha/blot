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

Measured against baba 7.3.0. These are checked into the repository so that a
grammar change which quietly degrades parallelism shows up in a diff instead of
in a benchmark months later.

| counter                    |              blot | gpu-duck | note                                               |
| -------------------------- | ----------------: | -------: | -------------------------------------------------- |
| `lexerStates`              |               102 |      175 | direct multiplier in the parallel DFA summary pass |
| `maxCandidateMultiplicity` |                 6 |        9 | worst-case island candidates allocated per token   |
| `islandCount`              |                19 |       24 |                                                    |
| `islandStates`             |               625 |        — |                                                    |
| `contractionRounds`        |                33 |        — | fixed dispatch bound                               |
| `denseTransitionBytes`     |           457,500 |        — | immutable device table                             |
| `packedBytes`              |           755,030 |        — | version-3 runtime section                          |
| `rootLoopIsland`           | 3 (`declaration`) |        — | strict root loop proven                            |

blot beats the gpu-duck reference on both counters that matter most for
occupancy, because it has three declaration forms where gpu-duck has six and no
type sublanguage at all.

`open` cost one lexer state and twenty-one island states — one keyword and one
declaration alternative, with `maxCandidateMultiplicity` and `contractionRounds`
unmoved. A declaration form whose FIRST set is a keyword nothing else starts
with is the cheapest thing the profile can be asked for.

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

Three concessions, each recorded here so they are not rediscovered as bugs:

- **`return expr;` is a declaration form**, not a trailing bare expression. A
  bare final expression would break the strict root loop, which requires the
  root to be one repeated island with an explicit structural boundary.
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
