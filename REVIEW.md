# Language review — 2026-08

A full review of Blot as specified in `LANGUAGE.md`, the prelude, `spec/`, and
the state recorded in `docs/roadmap.md`. Like `SUGGESTION.md`, these are
suggestions, not accepted rules; `LANGUAGE.md` and `spec/` remain authoritative.

The review covers both theory (the type system, refinement, effects, ownership,
and the formal model) and language design (surface forms, the prelude, and
ergonomics). Items are ranked within each section; a priority list closes the
document.

## What holds up

These decisions are the language's identity and none of the suggestions below
should reverse them.

- **Types are values.** One evaluator, no type sublanguage, no kind system.
  Compile-time dispatch (§4.1's branch-selected typing) already does what most
  languages need typeclasses or HKT for, and does it with visible source.
- **Modules are unary functions and authority is the argument.** The capability
  story is the cleanest part of the design: no ambient prelude, no ambient
  filesystem, and the entry parameter is the complete host authority. The
  "importer's record must satisfy every projected field" rule with width
  subtyping in both directions is the right module contract for this lattice.
- **Surface forms desugar; they do not get machinery.** `for` as a fold with an
  inferred accumulator, `break` as loop-local control, early `return` as an
  unspellable tagged result, `try` as bounded handler composition — all
  eliminated at CST lowering. This is the discipline that keeps every
  downstream pass small, and it has held.
- **Ownership out of the lattice.** Keeping linearity a flow analysis is what
  keeps biunification polynomial, and the ownership-certificate design (replay
  before lowering consults it) is the right trust boundary.
- **Proof-carrying array access.** `@array.get` demanding a replayable
  difference-constraint certificate, with the total `Array.get` as the ordinary
  path, is honest about what the checker knows. `Iter.indexed` as the
  proof-producing traversal closes the common loop without a bounds re-check.
- **No truthiness, no ternary, eager-and-explicit effects.** `<-` as the one
  effect-admitting declaration form makes effects visible in exactly one shape.

## Theory improvements

### T1. Let signatures bind an effect-row variable

§12.4's "a written row is closed" makes every higher-order combinator
unspecifiable: `('a -> 'b ~ { e }) -> 'a -> 'b ~ { Console, e }` is printed but
cannot be written, so `map`, `each`, any callback-taking export, and any
handler-shaped library function can be given a signature only by fixing the
callback's row. This is the single largest expressivity hole in the type
system, and it is cheap to close:

- The roadmap's argument against record rows does not apply here. An effect row
  is a set of labels with no types under them; row polymorphism over label
  *sets* (no duplicates, no field types, subsumption already defined as "fewer
  effects is a subtype") has principal solutions in exactly this lattice.
  Inference already maintains internal row variables — it prints them as `e`.
- The change is confined to `sig` elaboration: allow one written tail,
  `~ { Console, ..e }`, binding `e` for the extent of that signature (both
  occurrences must appear; a tail alone on the outer arrow with no bound
  occurrence stays refused as the unconstrained-variable case §12.4 rightly
  fears).

Nothing about inference changes; the signature language catches up with what
the checker already computes.

### T2. Make narrowing compositional instead of shape-recognized

§8.5 recognizes a comparison by pattern-matching the function's body: exactly
one `@int.cmp p1 p2` application, one occurrence of each parameter, no `open`
or `rec` in the body, junctions recognized by tabulating truth tables over four
boolean inputs. This works, but it is fragile in a characteristic way: an
eta-expansion, a logging wrapper, or a comparison written as two comparisons
silently loses narrowing, and the failure mode is a distant
`BLOT_INCOMPLETE_CASE` with no pointer to the cause.

The compositional alternative is to define narrowing on the primitive's
*result* rather than on the function that wraps it:

- `case @int.cmp n k of #Less => …` narrows `n` in each arm directly. This is
  ordinary abstract interpretation of the reduction the checker already
  understands, with no occurrence counting.
- `Ord.lt`, `Eq.eq`, and every user wrapper then narrow automatically wherever
  comptime evaluation or specialization inlines them to the primitive form —
  which is the same machinery §4.1 already runs for branch-selected typing.
- The truth-table recognition for `&&`/`||` can be deleted outright if D3
  (below) lands, since the junctions become `if` nests the branch rule already
  handles.

Recognition-by-shape becomes a fallback rather than the definition, and the
spec's list of refusals in §8.5 shrinks to the genuinely undecidable cases.

### T3. Carry Phi across affine index arithmetic

§10.3 lists range-refining arithmetic as a deliberate limit: `@int.add n 1`
widens to `Int` whatever was proved about `n`. But Phi is already a
difference-constraint system — §8.5 tracks affine shifts of a *length* by an
integer literal (`length - 1`), and the certificate checker replays
difference constraints. `n' = n + 1` is a difference constraint. Extending the
same treatment to the subject side (an index carried across `+ literal`
keeps its relation, shifted) is:

- sound in the same fragment (difference-bound matrices; incremental closure is
  standard);
- the single highest-value inference improvement for real programs — today a
  hand-written `i := i + 1` loop loses its bounds proof on the first
  iteration, forcing every indexed loop through `Iter.indexed`; and
- already half-specified, since lengths get exactly this treatment.

Overflow is the one caveat: `+ 1` on `Int` can trap rather than wrap, and a
trap ends the program, so the proposition never becomes false on a path that
continues. That argument belongs in `spec/TYPECHECKING.md` next to the
existing `0 <= len <= 2147483647` assumption.

### T4. Make float comparison total with a four-way answer

`Float.cmp` refusing NaN — diagnostic at compile time, trap at run time — turns
every runtime float comparison into a potential fault and taxes numeric code
with an `is_nan` pre-check per comparison. IEEE 754 defines exactly the total
answer: comparison yields one of four relations. Replacing the trap with

```blot
#Less | #Equal | #Greater | #Unordered
```

is more honest than trapping, stays entirely within the "no float equality"
philosophy (`is_equal` still refuses `#Unordered` by not matching it), and
converts a runtime trap into a compile-time exhaustiveness obligation — the
`case` over the result must say what `#Unordered` means *here*, which is
precisely the question NaN forces. Keep `@float.is_nan`; it remains the direct
ask. The current trapping `cmp` can remain as `cmp_ordered` for code that has
already proved its inputs, mirroring the `Array.get`/`@array.get` split.

### T5. Long-term: let a `sig` relate a parameter to a length

Phi is deliberately unspeakable in signatures (§10.1), so a proved-safe helper
like `at` cannot export its precondition; every caller re-proves it or eats the
total-API `Option`. Range types already put value bounds in signatures
(`0..`, `Nat`); the missing step is one relational form,
`n < @array.len xs`, restricted to the same difference-logic fragment the
certificates already replay. This is liquid-types-lite over machinery that
exists. It is a large specification change (function types gain a relational
component; subtyping on it is implication in a decidable fragment), so it
belongs after T1–T3, but the design should be sketched before the ABI and
capsule formats harden further, because a capsule that cannot carry the
relation forces re-inference forever.

### T6. Count recognized guard partitions toward coverage

"A guarded arm does not count towards coverage" is sound but coarser than the
checker's own knowledge: `m if m > 0`, `m if m < 0`, `0` partitions `Int`
using exactly the comparisons §8.5 recognizes. Once T2 lands, letting a
recognized-comparison guard contribute its proved set to coverage is a small
soundness-preserving generalization. Low priority; the wildcard-plus-`@panic`
idiom is an acceptable interim.

### T7. Pay down the formal-model debt where the risk is

`formal/lean` proves trace-order lemmas over a small core. The theorems worth
having are the ones no test can give confidence in:

1. linearity is preserved by the `for` desugaring (the accumulator fold moves
   obligations exactly as the surface reading implies);
2. Phi's frame conditions — `:=` invalidation and alias retention are exactly
   the rules in §8.5, i.e. no proposition survives a rebinding it shouldn't;
3. ownership-certificate replay soundness: a Store reuse the checker authorizes
   cannot observe a value the source program could still read; and
4. handler cancellation (`Continuation.cancel`) discharges precisely the
   obligations of the suspended computation.

Each matches a subtle, hand-argued invariant that a refactor could silently
break, and each is small enough to state over the existing core model.

### T8. Give unexported effects a nameable identity

§12.4: a module that acquires authority through a library whose effect is not
exported "receives that effect in its own inferred rows and cannot write
them" — so its public API cannot carry signatures. Capability secrecy is worth
keeping, but nameability and constructability are different rights. An
`effects_of` type tool (`Reflect`-adjacent: `effects_of f` yields the row of an
arrow as an opaque, write-only row value usable in `~ { … }`) lets a consumer
document its type without gaining the ability to handle or forge the effect.
Alternatively, the convention "libraries export effect identities they leak
into rows" could be stated in `LANGUAGE.md`; today the spec documents the trap
without a way out.

## Language design improvements

### D1. Allow a bare trailing expression as a scope's value

The `return`-everywhere style is the biggest readability tax in the language.
Three distinct meanings share one keyword — supply a value-`if`/`case` branch,
exit an explicit block, exit the module — disambiguated by an invisible
property (whether the enclosing form is a "result scope"). The formatter makes
it heavier still by rewriting direct branch values into blocks with explicit
`return`. Every function body pays.

The stated reason a bare trailing expression is refused is keeping
`name := value` distinct (§6.4). But the ambiguity exists only for a final
line of the exact shape `name := …`, and `:=` as the last statement of a block
is already dead code in a value position (its rebinding is read by nobody).
Refusing that one dead shape — "a block's final statement may not be `:=`" —
resolves the grammar with one local rule and frees every other block to end in
its value. `return` remains for early exit, which is what the keyword means
everywhere else. If the parser cannot afford the lookahead, the smaller
version — allow direct expressions (no block) as value-`if`/`case` branches
without `return`, and stop the formatter expanding them — recovers most of the
reading cost at zero grammar risk.

### D2. Compile-time-dispatched arithmetic and equality

Two facts currently combine badly: no operator serves more than one numeric
domain (§2.2), and `==` targets `Eq.eq` over `@int.cmp` — so `"a" == "a"` is a
type error (still true per the roadmap), and float code cannot use `+`. The
"one binding by name, no runtime dispatch" invariant is right; but the
language's own comptime machinery is the way through, and it needs exactly one
new capability: a compile-time branch on the *inferred type* of an argument
(the checker has it; source cannot ask for a runtime value — `@type.of`
evaluates). Give the prelude a `@type.case`-style primitive (or specializer
support for it) and:

- `Num.add` becomes one binding whose specialization is `@int.add`,
  `@float.add`, or `@f32.add` per instantiation — dispatch at compile time,
  zero runtime cost, one name for `+`;
- `Eq.eq` covers `Int` and `Str`, the two domains the pin rule already
  identifies as having exact equality in every execution.

This composes with T2: after specialization the residual comparison is the
single-primitive form narrowing recognizes, so dispatched `==` still narrows.
If a new primitive is unacceptable, the fallback is the OCaml answer — distinct
float operators (`+.` family) in the default fixity table, and retargeting `==`
at a new `@scalar.cmp` covering `Int` and `Str`. Either way, `"a" == "a"`
failing must not survive to a language anyone is asked to write.

### D3. Desugar `&&` and `||` to `if`

Eager junction operators are defended as the honest cost of "nothing is built
in", but the checker already treats them as special: it recognizes them by
truth table to define narrowing, and the spec's own canonical bounds idiom
(`n >= 0 && n < @array.len xs`) reads as a guard while evaluating both sides.
The language's stated philosophy — surface forms desugar — points the other
way: make `&&`/`||` grammar forms that desugar to nested `if` during CST
lowering, like `for` and `try` already do. Short-circuiting falls out,
narrowing becomes the ordinary branch rule on the desugared nests (deleting the
truth-table machinery), and `a && perform ()` stops being a foot-gun. The cost
is honest too: two spellings leave the operator table. They were already not
ordinary operators — a fixity entry the checker pattern-matches by semantics is
built in, in the way that matters.

### D4. Rebalance the element special case

Element syntax carries the language's only syntax-keyed typing rule: an
element property record is a *closed* row while every ordinary record has
width subtyping. The typo-protection motive is good, but a second
record-checking rule selected by call-site spelling is exactly the "second way
to say what the language already says" the invariants prohibit —
`div { .class = …; } [children]` is the same program without the protection.
Two better homes for the check: make closedness a property of the component's
declared parameter (a `sig` marker on the property record, e.g. an exact-shape
type built from `Is`), so the rule lives in the type and applies to both
spellings; or accept elements as they are but say in `LANGUAGE.md` that the
closed row is the component author's contract, checked wherever the type
appears. Separately: if UI is not a core domain for the language, elements are
a large grammar surface (`</`, `/>`, property forms, child suspension) for one
library shape — worth an explicit statement of why they are in the grammar
rather than a declaration-tag transform.

### D5. Give text the operations the language's own goals require

The roadmap's Done criterion is a program that "reads input, takes text
apart" — and text cannot currently be taken apart. The whole surface is
`concat`, `len`, `cmp`, `contains`, `of_int`. Missing, and mostly requiring
new primitives (which is fine — that is what "cannot be written in blot at
all" means):

- code-point iteration (`Text.chars` as an ordinary iterator shape) — the one
  primitive that unlocks `split`, `find`, `trim`, and parsers as prelude
  source;
- slicing by code-point range (or a byte-view with checked boundaries);
- `Text.to_int` / parse — currently no path from text to number at runtime;
- `Text.of_float` — currently a float cannot be printed;
- text interpolation as a pure desugar to `Text.append` chains over `Str`
  expressions only (no implicit to-string, keeping conversions explicit) —
  optional, but it follows the desugaring philosophy exactly.

Same list, smaller: `Array.find`, `Iter.map`, `Option.map`, `Result.map` are
acknowledged absent. The prelude is the language here; these gaps read as
language gaps.

### D6. Tighten the two quiet behaviors in `for`

Two rules make loops quietly do something other than what was written:

1. **A refutable binder pattern skips non-matching elements** (§9). A silent
   filter is a bug-shaped convenience: a constructor added to an element type
   makes existing loops skip data with no diagnostic anywhere. Require the
   explicit spelling instead — an irrefutable binder plus `if let` in the body
   — or, if the filtering form is wanted, give it a visible spelling
   (`for #Some x in …:` could stay legal only when the checker can prove the
   match total, mirroring `case` coverage).
2. **The accumulator set is derived by scanning the body for `:=`.** The
   carried-names bug the roadmap records (a `:=` inside a statement `if` not
   carried, silently wrong answer, whole corpus written around it) is the
   fragility signature of derived-by-scan semantics. It is fixed; the design
   remains one where a typo'd `:=` silently changes the fold's state record.
   Worth considering: report a `:=` in a loop body whose name is never read
   after the loop *and* never read by a later iteration — the write nobody
   observes is almost always the typo case.

### D7. Let a module state its parameter

A module's demand on its parameter is inferred from its projections, and the
error at the application names the missing field — good. But there is no way to
*declare* the parameter, so a module's authority surface is documentation by
excavation. An optional constraint in the header (the module form already
exists; allow `sig` for the parameter name immediately after it, checked as an
upper bound exactly like any other `sig`) costs no inference and gives entry
modules a visible capability manifest. The inferred demand remains the truth;
the signature is the human-facing bound on it.

### D8. Decide the unsigned-64 story before users hit the trapdoor

`U64` is a valid storage descriptor whose runtime inhabitants are
`BLOT_UNREPRESENTABLE_INTEGER` — a correct but surprising cliff reachable by
writing a plausible struct field and then touching it. Either a `Word` domain
(unsigned 64-bit with its own primitives, no implicit conversion — consistent
with the existing "a full-width unsigned runtime value would need a distinct
word domain" note) should be scheduled, or `LANGUAGE.md` should promote the
current one-sentence caveat into a rule of thumb with the workaround
(`I64`-carried bit patterns and where they break). The diagnostic should point
at whichever answer is chosen.

### D9. Naming and sigil-budget cleanups

Small, but they compound in a language that prizes one-way-to-say-it:

- One domain, three names: type `Str`, namespace `Text`, primitives `@text.*`.
  Pick one stem (renaming the type to `Text` or the namespace to `Str` are
  both fine; the primitives should match the namespace).
- `@fail` (compile-time refusal) vs `@panic` (runtime trap) — the names do not
  say which phase; `@comptime.fail` or a doc rule of thumb would.
- The sigil load on `!` `?` `&` `<` `>` is at its budget: each is two or three
  of {prefix ownership marker, infix operator, element delimiter, optional
  field marker}. All are grammar-position-resolved today; treat the budget as
  spent and give any future feature a word, not a sigil.

### D10. Spread of a signature-typed parameter should carry the declared fields

`fn r => { ...r; .tag = 1; }` produces `.tag` and nothing else, because width
subtyping cannot say what `r` carries. When `r` has a `sig`-declared record
type, there is a sound, deterministic reading with no row variable: desugar
the spread to an explicit copy of exactly the declared fields
(`{ .x = r.x; …; .tag = 1; }`). The result type and the runtime value agree
field-for-field, `BLOT_SPREAD_MAY_OVERWRITE` keeps its meaning for the
undeclared case, and the default-then-override idiom becomes writable
precisely where the program said what it meant. This is the same move the
language makes everywhere else: the explicit form is the semantics, and the
convenient form desugars to it.

### D11. Write the concurrency design note before ABI 2

Nothing in the spec says what concurrency will be, and the ingredients on hand
(one-shot continuations, effect handlers, a host boundary of typed imports)
admit the standard answer — async as a host effect whose handler owns the
schedule. That answer constrains the ABI (suspension across the boundary, or
the decision to forbid it) and the ownership story (a linear value captured by
a suspended computation is exactly the `!resume` case, generalized). A one-page
design note now is cheap; retrofitting after ABI 1 accretes exports is not.

## Priorities

If only five things get done:

1. **T1** — signature-level effect-row tail. Smallest change, unblocks every
   higher-order signature.
2. **D2** — comptime-dispatched `Num`/`Eq`. `"a" == "a"` failing is the first
   thing a new user hits.
3. **T3** — Phi across `i + 1`. Makes hand-written indexed loops provable; the
   machinery exists.
4. **D1** — bare trailing expression (or at least direct branch values).
   Biggest single readability win, purely local grammar rule.
5. **D5** — text primitives. The language's own Done criterion is unreachable
   without them.

T4 (total float compare) and D3 (`&&` desugar) are next: both delete a trap or
a recognition machine rather than adding anything.
