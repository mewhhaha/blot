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

### D1. Explicit `return` — reviewed and retained

The first draft of this review proposed allowing a bare trailing expression as
a scope's value. The proposal is withdrawn: explicit `return` stays. The
visibility argument wins — every value that leaves a scope is spelled the same
way, a branch boundary is visible even when its result is short, and a block's
result is never a line whose role depends on what precedes it. It also keeps
`name := value` unambiguous with no lookahead rule, and keeps the formatter's
vertical conditional layout uniform between statement and value forms. Recorded
here so the trade-off is a decision rather than an accident.

### D2. `==` as a source operator over an `Eq` interface looked up on the type

Two facts currently combine badly: no operator serves more than one domain
(§2.2), and `==` targets `Eq.eq` over `@int.cmp` — so `"a" == "a"` is a type
error (still true per the roadmap). The fix is not a new equality primitive
and not runtime dispatch. `==` stays an ordinary fixity entry naming a
source-defined target with type

```text
a -> a -> Bool
```

whose body resolves the implementation by **interface lookup on the
argument's type**: a compile-time function from the type value to its `.eq`.
The language already has both carriers the lookup needs:

- attached namespace members (`@type.attach`; the `struct` and `bit_width`
  precedent) carry `.eq` for sealed and constructed types — a `seal`ed
  nominal type participates by attaching its own equality, with no new
  syntax; and
- `reflect` dispatch covers the built-in domains — `#Range` with
  `.domain = #Int` resolves to `@int.cmp`, `#Text` to `@text.cmp` — which is
  ordinary prelude source over the reflection that exists today.

One checker capability is missing: compile-time code cannot see the inferred
type of a runtime argument (`@type.of` evaluates its operand, which on a
runtime value is an error by design, §13.3.1). The lookup needs the
instantiation's type value delivered to the target's body at specialization —
either a designated `@type.of_argument` usable only in this position, or a
typing rule that treats the interface-lookup function specially, the way
`@handle` is already special for its own reason.

What falls out is better than a dispatch table:

- `"a" == "a"` works, resolved to `@text.cmp` at compile time;
- `F64` attaches no `.eq`, so float equality stays refused *by construction*
  — the deliberate absence in §2.2 becomes a property of the type rather
  than a rule about an operator;
- there is no instance scope and no orphan problem, because the
  implementation travels on the type value itself — consistent with "nothing
  is implicitly in scope"; and
- the same mechanism generalizes: `Num.add`'s target looks up `.add` the
  same way, giving `+` over `Int`, `F64`, and `F32` with zero runtime cost
  and one name per operation.

This composes with T2: after specialization the residual comparison is the
single-primitive form narrowing recognizes, so looked-up `==` still narrows.

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

### D12. Reflection: package evidence instead of adding primitives

Measured against Zig and OCaml, blot's reflection surface is already the easy
kind. `@type.reflect` is `@typeInfo`; `@shape.get`, `@shape.has`, and
`@shape.names` are `@field`, `@hasField`, and the field list; a comptime fold
over a field-name array partial-evaluating into direct projections (§15) is
`inline for`; and blot needs no `@Type()` reify because construction and
description live in one value domain — a record type is a record of types.
OCaml's deriving story, ppx, is syntactic preprocessing outside the language;
declaration tags are already its semantic superior.

Where blot is harder than Zig is not a missing primitive but *where checking
happens*. Zig checks a reflective body only at instantiation, so evidence is
never a question — everything is concrete by the time anything is checked.
Blot wants principal checking, so §13.4 marks a reflect payload that cannot be
related back to the reflected input as unevidenced: manipulable at compile
time, unable to discharge a runtime `sig`. That marking is the real tax on
derive-style code. Two moves address it, one novel and one borrowed:

1. **Evidence-packaged reflection.** Blot already invented the pattern for
   arrays: `Iter.indexed` packages the bounds proof with the value at the one
   primitive that has the authority to mint it. Apply the same rule to
   reflection — let the shape and variant cases yield operations, not just
   descriptions: each field as
   `{ .name; .type; .get = T -> F; .set = (T, F) -> T; }`, with `.get` and
   `.set` born typed against the reflected `T`. Deriving `eq`, `show`,
   serializers, and lenses then composes minted accessors instead of
   re-deriving projections from names, and the unevidenced marking never
   arises on the dominant uses. No dependent types; the compiler mints the
   evidence where it has it, exactly like the index proof.

2. **Check the reflective fragment at instantiation.** The specializer
   already visits every concrete instantiation. Letting that visit be the
   authoritative check for functions the conservative pass marked unevidenced
   turns "cannot discharge a `sig`" into "checked where the types are
   concrete". The cost is Zig's cost — use-site errors — confined to the
   code that opted into reflection.

A third step is pure prelude: a canonical sum-of-products view derived over
`reflect` (Scala 3's `Mirror`, generics-sop). Most derive-style code needs
only "sums of products of scalars, plus the iso", and folding a
two-constructor view is far easier than the full reflection variant.

## Priorities

If only five things get done:

1. **T1** — signature-level effect-row tail. Smallest change, unblocks every
   higher-order signature.
2. **D2** — `==` over an `Eq` interface looked up on the type. `"a" == "a"`
   failing is the first thing a new user hits.
3. **T3** — Phi across `i + 1`. Makes hand-written indexed loops provable; the
   machinery exists.
4. **D5** — text primitives. The language's own Done criterion is unreachable
   without them.
5. **T4** — total four-way float comparison. Deletes a runtime trap and turns
   it into an exhaustiveness obligation.

D3 (`&&` desugar) is next: it deletes a recognition machine rather than adding
anything.
