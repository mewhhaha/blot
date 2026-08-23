# Design suggestions

These are the remaining changes I would pursue after indexed arenas and the
initial recursive-value representation work. They are suggestions, not accepted
language rules; `LANGUAGE.md` and `spec/` remain authoritative.

Sections 1 through 6 are representation and compiler work. Sections 7 onward
came from a review of the language itself — inference, effects, refinement,
reflection, and the surface — and are ordered by what they unblock rather than
by size.

## 1. Implemented: close positive recursive algebraic values

Inference already accepts the useful equation

```text
List A = #Nil | #Cons (A, List A)
```

Runtime HIR schema 3 now settles that equation to a finite graph. It allocates a
private indirect root before compiling the positive constructor body, fills the
target afterward, and emits scratch-arena `indirect.make` and `indirect.load`
operations. A recursive sum is therefore an address to a tag and payload, while
non-recursive records and sums keep their flat representation.

The mechanism is automatic. Adding source-level `Box`, pointer types, or
lifetime parameters would expose a target repair as a language concept and make
ordinary algebraic data harder to read. Recursive values should remain barred
from ABI 1 until a canonical cyclic graph format is designed; an internal list
used to produce a scalar can safely die with the export call's scratch arena.

The executable probes cover direct and mutually recursive values, empty and
singleton cases, constructor projection, exhaustive matching, ABI refusal, and
scaling against the indexed `Arena` baseline. The private indirect edge is not a
source ownership location: it remains call-local and cannot cross ABI 1.
Source-level variant, record, and consuming-array extraction lineage is instead
published by ownership certificate schema 3.

## 2. Give Store an explicit capacity only when profiles require it

Affine `Arena.insert` now extends the most recent allocation in place. That is
`O(1)` per fixed-size node while nothing allocates between the Store and its
append. A node containing freshly allocated text or another Store breaks that
condition and falls back to copying the prefix.

If those workloads matter, change the private Store representation from
`(pointer, length)` to `(pointer, length, capacity)` and grow capacity
geometrically under owned-reuse permission. Keep the public ABI at
`(pointer, length)` through adapters. Do not add capacity pre-emptively: it adds
a local and adapter work to every array operation, while the current bump-tail
case already covers compact arena nodes. In the equal-semantics Wasm benchmark,
the compact arena takes 4.76 µs versus Rust's `Vec` arena at 3.04 µs for 1,024
nodes. That remaining 1.57× gap does not by itself justify changing every Store;
profile payload-allocation fallbacks separately before paying the capacity cost.

The benchmark now measures the direct recursive list too. At 1,024 nodes it
takes 9.36 µs, versus 19.30 µs for Rust `Box` recursion and 4.76 µs for Blot's
indexed arena. Private indirection is therefore linear and competitive with the
matching recursive Rust representation, while the compact arena remains the
throughput-oriented choice.

## 3. Keep recursive discovery in the checker graph

The checker now builds the free-name graph of each typed `rec` group and finds
its strongly connected components in `O(V + E)`. Certificate schema 3 persists
the recursive closure bodies. Runtime HIR closing allocates a private root only
when that certificate authorizes the exact body, then fills its positive
constructor edge and validates the finite graph:

```text
discover SCCs -> allocate RuntimeTypeId placeholders -> fill edges -> validate
```

An unresolved result without the certificate is refused. Formatted type strings
remain in specialization cache keys; replacing those with structural identities
belongs to the broader progressive checked-to-HIR construction work rather than
recursive representation soundness.

## 4. Defunctionalize a branch join rather than adding function pointers

A dynamic branch whose arms are functions used to reach the residual value
calculus refusal, because the join lost the set of lambdas the arms could
produce. That set is finite and known, so the join now carries a private sum:
its case selects a normalized closure source and its payload is that
alternative's ordered runtime capture product. Application dispatches on the
tag, projects the payload back into the captures, and applies the selected body,
so each call site still specializes for the argument representation it supplies
— the probe applies one selected lambda to two different record widths and each
gets its own code.

Two decisions carry the weight. Alternatives merge only when they name the same
source _and_ the same closed environment or equal already-applied arguments;
merging on the body alone would make `make 1` and `make 2` compute one answer.
And an arm that is already a choice contributes its own alternatives, so nesting
a choice inside a choice produces one flat table rather than a tree of tags.

This is deliberately not a function-pointer representation. `call.indirect`, a
runtime code table, or a uniform closure record would each make every joined
function opaque to specialization and would put a dispatch the compiler cannot
see into a language whose ownership analysis depends on knowing the callee. The
table is refused at ABI 1 for the same reason: its cases name compiler-local
closure sources, so no caller could read one.

## 5. Require evidence before adding algebraic loop rewrites

Runtime HIR now rewrites direct self-tail calls to block back-edges, including
the private sum and product reconstruction introduced by source elaboration. The
emitter turns a reducible entry cycle into structured WebAssembly and keeps the
dispatcher for non-entry cycles or excessive path expansion. HIR also removes
known boolean and sum constructor/tag round-trips before structuring. That
covers direct recursion, range folds, surface iteration, and arena-list
construction and traversal without source-level loop machinery or a separate
loop IR.

Equal-semantics Rust-Wasm measurements now put the representative scalar loops
within normal engine noise of their Rust counterparts. A range-sum formula could
still reduce asymptotic work, but it is no longer justified as repair for a
general loop overhead. Add one only with a source theorem covering integer
overflow and iteration boundaries, plus a workload where the removed work
matters outside the benchmark itself. Indirect and mutual recursion should
remain calls until a separate control-flow argument covers them.

The general recovery remains shared by ordinary recursive traversals, while a
special formula improves one pattern. Each new rewrite still needs a
source/Runtime-HIR simulation argument and trap-preservation tests before its
performance measurement counts.

## 6. Keep compiler optimization profile-driven

The resident compiler already returns unchanged artifacts in tens of
microseconds; lowered-module edits are dominated by checking and Runtime-HIR
preparation rather than emission. A current nine-sample profile measured the
list-heavy example at 23.6 ms: 6.60 ms checking, 14.4 ms preparing HIR, and only
0.293 ms emitting. Its final HIR has 63 operations, so the preparation cost is
staged recursive evaluation and residual-trace reconstruction rather than final
graph size. The next compiler work should continue the existing flat-arena plan:
progressively emit settled Runtime HIR during checking and delete request-local
fact-map reconstruction. Parallelism and SIMD should wait for a profile that
shows independent ready modules or contiguous set scans dominating wall time.

An optimization is successful only when it removes a derivation or makes its
data contiguous. Moving the same derivation between TypeScript, Rust, and Wasm
is not a compiler-speed improvement.

## 7. Current theory/implementation frontier

The representative scalar tight-loop gap is closed: equal-semantics Blot and
Rust Wasm are within 0.91--1.06x on the measured loops, and the indexed arena is
about 1.5x Rust's `Vec`. Recursive values, nested static function aggregates,
known higher-order selection, path-sensitive ownership summaries, and generated
staging/handler/target simulations now have executable boundaries.

What remains falls into three different classes and should not be described as
one unfinished feature list:

- **Semantic closure:** finite run-time choices returned by known higher-order
  functions are defunctionalized, and so is a dynamic branch that joins several
  functions: the join normalizes each arm to a closure source plus its ordered
  runtime captures and carries the result as a private tagged table. A function
  whose source set is opaque to whole-program control-flow analysis still needs
  closure conversion with a closed parameter representation or a representation
  dictionary. That open set is now the only source program that can be well
  typed yet reach a structural representation refusal, and it is refused with
  the offending value and its inferred signature rather than with a generic
  value-calculus message.
- **Compiler architecture:** progressively commit typed Runtime HIR during
  checking. This removes duplicate derivations and does not need new surface
  syntax.
- **Evidence:** mechanize preservation/progress for the stable core. Generated
  tests now cover returns, staging, handlers, ownership-path mutations, host
  order, checked-integer traps, divergence, and evaluator/Wasm agreement, but
  remain bounded simulations rather than a proof.

Capacity-bearing Stores, another proof-producing collection, first-class
references, and a full-width word domain are contingent extensions. The current
profiles and examples do not justify adding them to the language or runtime.

## 8. Implemented: let a signature name the rest of an effect row

§12.4 now admits a written tail such as `..e`, so callback-taking exports can
relate the callback's inferred row to the row they return without fixing either
to a closed set. The source spelling matches the checker printer rather than
leaving an inferred interface that signatures cannot express.

The argument against record row variables does not transfer. An effect row is a
set of labels with nothing under them, subsumption is already "fewer effects is
a subtype", and inference carries these variables today: the `e` it prints is
one. Row polymorphism over label sets has principal solutions in this lattice. A
record row would need field types and the concatenation and override operations
shape syntax can write, which is the reason that one has none.

The implemented `sig` elaboration uses one written tail, `~ { Console, ..e }`,
binding `e` for the extent of that signature, with both occurrences required. A
tail on the outermost arrow with no second occurrence stays refused, which is
the unconstrained-variable case §12.4 is right to fear. Inference does not
change; the signature language catches up with what it already computes.

## 9. Resolve `==` through an interface carried on the type

`"a" == "a"` is still a type error because `==` names `Int.eq` over `@int.cmp`.
The repair is not a second equality primitive and not runtime dispatch. `==`
stays an ordinary fixity entry whose target is source with type

```text
a -> a -> Bool
```

and whose body resolves the implementation by interface lookup on the argument's
type.

Both carriers exist. Attached namespace members (`@type.attach`, the `struct`
precedent) hold `.eq` for sealed and constructed types, so a nominal type
participates by attaching its own equality and no syntax is added. `reflect`
covers the built-in domains: `#Range` with `.domain = #Int` resolves to
`@int.cmp` and `#Text` to `@text.cmp`, which is ordinary prelude source.

One checker capability is missing. Compile-time code cannot see the inferred
type of a runtime argument — `@type.of` evaluates its operand, which on a
runtime value is an error by design (§13.3.1). The lookup needs that type value
delivered to the target's body at specialization, either through a primitive
admissible only in this position or through a typing rule for the lookup
function, which is how `@handle` is already special for its own reason.

What follows is better than a dispatch table. F64 equality stays refused because
`F64` attaches no `.eq`, so §2.2's deliberate absence becomes a property of the
type rather than a rule about an operator. There is no instance scope and no
orphan question, because the implementation travels on the type value. The same
mechanism gives `+` one name over `Int`, `F64`, and `F32` by looking up `.add`.
Do not let it become implicit dispatch: the lookup is compile-time, the resolved
target is visible in the specialized program, and a type that attaches nothing
is a diagnostic rather than a fallback.

## 10. Narrow on the primitive rather than on the shape of its wrapper

§8.5 recognizes a comparison by inspecting the wrapper: one `@int.cmp p1 p2`
application, one occurrence of each parameter, no `open` or `rec` in the body,
and junctions identified by tabulating a truth table. It is sound, and it is
fragile in a characteristic way — an eta-expansion or a logging wrapper loses
narrowing, and the failure surfaces as a distant `BLOT_INCOMPLETE_CASE` that
says nothing about the cause.

Define narrowing on the primitive's result instead. `case @int.cmp n k of`
narrows `n` in each arm by ordinary abstract interpretation of a reduction the
checker already performs, with no occurrence counting. Every wrapper then
narrows wherever comptime evaluation or specialization inlines it to that form,
which is the machinery §4.1 already runs for branch-selected typing, and is what
keeps this composing with the interface lookup above. Recognition-by-shape
becomes a fallback, and §8.5's list of refusals shrinks to the cases that are
genuinely undecidable.

Two consequences follow, neither worth making before the primitive-level rule
exists. `&&` and `||` should become grammar forms that desugar to nested `if`
during CST lowering, like `for`: short-circuiting falls out, the truth-table
recognition is deleted rather than reimplemented, and `a && perform ()` stops
performing. They are not ordinary operators today — a fixity entry the checker
matches by semantics is built in, in the way that matters. And a guarded arm
whose guard is a recognized comparison can contribute its proved set to
coverage, so `m if m > 0`, `m if m < 0`, `0` covers `Int` without a wildcard.

## 11. Carry the index relation across affine arithmetic

§10.3 widens `@int.add n 1` to `Int` whatever was proved about `n`, so a
hand-written `i := i + 1` loop loses its bound on the first iteration and every
indexed traversal has to go through `Iter.indexed`. Phi is already a
difference-constraint system and already tracks affine shifts of a length by a
literal (`length - 1`); `n' = n + 1` is the same constraint on the other side of
the comparison.

Extend the existing treatment to the subject: an index carried across addition
or subtraction of a compile-time integer keeps its relation, shifted. The
fragment stays difference-bound, incremental closure is standard, and the
certificate checker replays what it already replays. Record the overflow
argument in `spec/TYPECHECKING.md` beside the existing
`0 <= len xs <= 2147483647` assumption: `+ 1` on `Int` traps rather than wraps,
and a trap ends the program, so the proposition never becomes false on a path
that continues.

Arbitrary arithmetic must still widen. The value of the rule is that it covers
the loop shape programs actually write, not that it approaches a general solver.

## 12. Answer float comparison totally

`F64.cmp` refuses NaN — a diagnostic while compiling and a trap while running —
so every runtime float comparison is a potential fault and numeric code pays an
`is_nan` pre-check per comparison. IEEE 754 defines the total answer, and
returning it is more honest than trapping:

```blot
const FloatOrdering = #Less | #Equal | #Greater | #Unordered
```

`is_equal` refuses `#Unordered` by not matching it, so there is still no float
equality. What changes is where the question is answered: a runtime trap becomes
a compile-time exhaustiveness obligation, and the `case` over the result has to
say what unordered means in that program, which is the question NaN actually
poses. Keep `@float.is_nan` as the direct ask, and keep the trapping comparison
under a name that says so for code that has already proved its inputs — the same
split `Array.get` and `@array.get` already make.

## 13. Return evidence from reflection, not descriptions

The reflection surface is already the easy kind: `@type.reflect` describes a
type the way a `@typeInfo` does, the shape primitives are field access and field
membership, a comptime fold partial-evaluating into direct projections (§15) is
an unrolled loop, and no reify primitive is needed because construction and
description share one value domain. Preprocessing-based deriving is not a model
to copy; declaration tags are already its semantic form.

The difficulty is not a missing primitive but where checking happens. A language
that checks a reflective body only at instantiation never has an evidence
question. Blot checks principally, so §13.4 marks a reflect payload that cannot
be related to the reflected input as unevidenced: usable at compile time, unable
to discharge a runtime `sig`. That marking is the whole tax on derive-shaped
code.

Apply the rule the array path already uses. `Iter.indexed` does not hand back an
index and require it to be re-proved; the primitive holding the authority
packages the proof with the value. Let the shape and variant reflection cases
yield operations rather than descriptions — each field as
`{ .name; .type; .get = T -> F; .set = (T, F) -> T; }`, minted already typed
against the reflected `T`. Deriving equality, rendering, serializers, and lenses
then composes born-typed accessors instead of rebuilding projections from names,
and the unevidenced marking stops arising on the uses that matter. No dependent
types are involved: the compiler mints evidence where it holds it, exactly as it
does for the index.

A canonical sum-of-products view over `reflect` is worth writing first and costs
no compiler change. Most derive-shaped code needs only sums of products of
scalars plus the isomorphism, and folding a two-constructor view is easier than
folding the full reflection variant.

## 14. Finish the value surface before adding another form

The Done criterion is a program that reads input and takes text apart, and text
cannot be taken apart. The surface is `concat`, `len`, `cmp`, `contains`, and
`of_int`. What is missing needs primitives, which is the correct reason to add
one — these cannot be written in blot at all:

- code-point iteration in the ordinary iterator shape, which is the single
  primitive that makes `split`, `find`, `trim`, and text parsers prelude source;
- slicing by code-point range, or a byte view with checked boundaries;
- text to integer, so runtime input can become a number; and
- float rendering, so a float can be printed.

`Array.find`, `Iter.map`, `Option.map`, and `Result.map` are ordinary prelude
source and are simply absent. Changing the prelude's public record updates
`LANGUAGE.md` §14 and the distributed snapshot in the same change.

Interpolation, if it is wanted, is a desugar to `Text.append` chains over `Text`
expressions with no implicit conversion. Do not add it before the primitives: a
form that makes text convenient to build while it remains impossible to take
apart is the wrong order.

## 15. Close the quiet behaviors

Three places where the accepted reading is not the written one. None needs new
machinery.

A refutable `for` binder silently skips elements that do not match (§9). Adding
a constructor to an element type therefore makes existing loops drop data with
no diagnostic anywhere. Require the explicit spelling — an irrefutable binder
and `if let` in the body — or keep the filtering binder only where coverage
proves the match total.

A spread of a parameter contributes no fields (§6), so
`fn r => { ...r; .tag = 1; }` returns a record with `.tag` alone. Where the
parameter's record type is declared by a `sig`, there is a sound reading with no
row variable: desugar the spread to an explicit copy of exactly the declared
fields. The type and the runtime value agree field for field,
`BLOT_SPREAD_MAY_OVERWRITE` keeps its meaning where nothing was declared, and
the idiom becomes writable precisely where the program said what it meant.

A module's demand on its parameter is inferred and unwritable, so its authority
surface is documentation by excavation. Allow a `sig` for the parameter
immediately after the header, checked as an upper bound like any other. The
inferred demand stays the truth; the signature is the human-facing bound on it.

## 16. Contingent, and what not to do yet

- **Relational signatures.** Phi is deliberately unspeakable in a `sig` (§10.1),
  so a proved-safe helper cannot export its precondition and every caller
  re-proves it or takes the total API's `Option`. One relational form restricted
  to the difference fragment the certificates already replay would close that.
  It is a large change — function types gain a relational component and
  subtyping on it becomes implication — and it should wait for section 10.
  Sketch it before the capsule format hardens further: a capsule that cannot
  carry the relation forces re-inference forever.
- **A word domain.** `U64` is a storage descriptor whose runtime inhabitants are
  `BLOT_UNREPRESENTABLE_INTEGER`, a cliff reachable by writing a plausible
  struct field. Section 6 already lists a full-width word domain as contingent;
  until a profile justifies it, `LANGUAGE.md` should carry the workaround rather
  than only the refusal, and the diagnostic should name it.
- **Concurrency.** Nothing states what it will be, and the pieces on hand —
  one-shot continuations, handlers, typed host imports — admit the ordinary
  answer of async as a host effect whose handler owns the schedule. That answer
  constrains ABI 1, in whether a suspension may cross the boundary, and
  generalizes the `!resume` ownership case. Write the design note before ABI 1
  accretes exports; do not add a form.
- **Mechanized invariants.** The evidence bullet in section 6 should name its
  targets: linearity preserved by the `for` desugaring, Phi's frame conditions
  under `:=` and aliasing, ownership-certificate replay soundness, and
  cancellation discharging exactly the suspended computation's obligations. Each
  is a hand-argued invariant a refactor can silently break, and each is small
  enough to state over the existing core model.
- **Naming.** One domain carries three stems — the type `Text`, the namespace
  `Text`, the primitives `@text.*` — and `@fail` and `@panic` do not say which
  phase they belong to. Both are cheap to settle and neither is urgent. The
  sigil budget is spent: `!`, `?`, `&`, `<`, and `>` each carry two or three
  grammar-position-resolved meanings, so a future feature gets a word.
- **Effect nameability.** A module that acquires authority from a library that
  does not export its effect receives it in inferred rows and cannot write them
  (§12.4), so its public API cannot carry signatures at all. Nameability and
  constructability are separate rights; an extractor yielding an arrow's row as
  an opaque, write-only value would restore the signature without granting the
  ability to handle or forge the effect.
