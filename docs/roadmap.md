<!-- Produced by a 13-agent workflow, then spot-checked by hand. Four claims
were re-verified directly before this was committed: the `for`/statement-`if`
silent wrong answer, the two checker-vs-evaluator disagreements, and that all 31
corpus programs lower. The width-subtyping reproduction is agent-verified only —
`just build` is unavailable while gpufuck's tree is broken. -->

# The finishing roadmap

## Vision

blot is a functional language whose syntax was designed against baba's parallel
GPU parser from the start rather than retrofitted to one, and whose whole
pipeline — CST, comptime evaluation, algebraic subtyping, linearity, gpufuck
Core, WebAssembly — fits in one small tree with no second backend and no parser
fallback. Everything is inferred. Types are values. Surface control forms
desugar to recursion and cases.

**Done** means: a programmer can write a real program — one that reads input,
takes text apart, builds records over runtime data, and returns a result — using
only `LANGUAGE.md`; the compiler either compiles it or refuses it with a message
naming the file, the line, and what to write instead; and the interpreter,
gpufuck's evaluator, and the emitted Wasm agree on what it means. None of that
is true today for a program the corpus does not already contain.

## State of the tree, verified 2026-07-30

Everything in this section was run. Anything not run is marked.

**The corpus is green and that is the problem.** All 31 programs in `examples/`,
all three case studies, and both library modules lower to gpufuck Core and pass
gpufuck's CPU-oracle type inference:

```
$ deno test --allow-read --allow-write --no-check --filter "lowers to gpufuck Core"
ok | 31 passed | 0 failed | 221 filtered out (21s)
```

Every claim in `docs/backend.md` and `docs/inference.md` about a corpus program
that cannot lower is stale. `examples/generics.blot`, `examples/comptime.blot`,
`examples/storage.blot`, `examples/effects.blot` and `examples/loops.blot` all
pass. The array-spread `F2104` on `loops.blot`, the `@type.reflect` refusal on
`generics.blot`, and the unit-in-tuple-parameter hole in `effects.blot` are all
resolved in the current tree — I could not reproduce any of them.

**Rank-N landed.** `docs/inference.md:147` is now accurate:

```
sig apply_both = @forall (a => (a -> a)) -> Int;
let apply_both = f => f 1 + Text.length (f "ab");
return apply_both (x => x);            -> Int

sig run2 = @forall (a => (a -> a)) -> Int;
let run2 = f => f 1;
return run2 (x => 42);
  -> BLOT_TYPE_ERROR: 42 is not the rigid type 's2.
```

The refutation case works, which is what proves it is not the `@type.unbounded`
approximation. There is no `examples/rankn.blot`; `grep -rn "@forall" examples`
is empty. The catalog rule says there should be one.

**Width subtyping lowers as of M3a; two shape cases remain.** The program below
was the reproduction, and staging was hiding it: `stageModule` (`src/stage.ts`)
constant-folds every `let` it can before lowering, and the corpus was almost
entirely foldable.

```blot
open {} = (@import "blot:prelude") ();
const Source = @effect.host { .value = Unit -> Int; };
let get_x = v => v.x;
n <- Source.value;
return get_x { .x = n; .y = 0; };
```

It compiled to `F2102: expected Shape0['a], received Shape2[I64, I64]` and now
builds: a projection reads the record that *flowed* to it, across the
instantiation each caller made. `examples/projected.blot` is that program with a
runtime source, and it is in `just wasm`, so the corpus is now evidence rather
than an avoidance. Two records reaching one projection is
`BLOT_SHAPE_DISAGREEMENT`, named at the span, with
`examples/rejected/semantics/shape_disagreement.blot` as the catalog entry.

What still reports `BLOT_LOWERING_BUG` is listed under "Remaining backend
boundaries" in `docs/backend.md`: a spread whose member type is still a variable
(M3a deliberately dropped that step), a parameter destructured in place, and a
projector reached across `@import` (M3c).

**Three places blot disagrees with itself.** Each verified by running `check` and
`eval` on the same file.

| program | `blot check` | `blot eval` |
| --- | --- | --- |
| `let f = c => case c of #Some v => v, _ => 0 end; f (#Some "hi")` | `0` | `"hi"` |
| `if let #Some v = c else do return 999; end; return v;` | `999` | `3` |
| `if let #Some v = c else do return "none"; end; in Text.append v "!"` applied to `Some 3` | `(Text \| "none")` | `BLOT_TYPE: @text.concat expects text, found 3.` |

The third is the important one: the checker accepts a program the evaluator
rejects on type grounds. `if let` is the flagship guard form in `LANGUAGE.md`
§8.3 and it gets zero typing from its own pattern.

**A silently wrong answer.** This returns `0`, and `check` and `eval` agree on
`0`:

```blot
let n = 0;
for x in Iter.range (0, 5) do
  if x > 2 then do n := n + 1; end;
end;
return n;                                  // should be 2
```

`carriedNames` (`src/syntax/lower.ts:1111`) only walks the loop body's top-level
statements, so a `:=` inside a statement `if` is an inner-scope shadow nothing
reads. The whole corpus is written around this — `case-studies/grep/main.blot`
pointedly writes `count := if matching then count + 1 else count end;` — and
nothing in the compiler says so.

**Runs but cannot compile.** A `const` that closes over a `let` checks (`Int`)
and evaluates (`2`), and only `build` refuses it. The refusal now names the
phase error — `BLOT_CONST_CAPTURES_RUNTIME` at the capture, naming both
bindings — rather than claiming the captured name is unbound. Refusing in the
checker instead, so `check` and `eval` agree with `build`, is still open
(item 1d).

**Diagnostics.** A type error now prints `file:line:col:` like a parse error on
the same path does. The checker always had the span; what was missing was the
file that span indexes into, which the diagnostic now carries — so an error
inside an imported module names *that* module, not the entry file. `describe`
renders a range through the printer, so `sig n = Nat; let n = -1;` names the
bound the value fell outside of (`0..`) rather than the word "an integer", which
was true of every range at once. The printer spells the unbounded text range
`Str`, the name a `sig` accepts; it used to print `Text`, which is the prelude's
*namespace record*, so copying the compiler's own output into a `sig` failed
with `BLOT_SIG_NOT_A_TYPE`. Still open: one error per run, the file-wide span
fallback, no `blot fmt` (``unknown command `fmt` ``), and 26 `unsupported()`
sites with no user-readable list.

**The standard library ends early.** The complete text surface is
`@text.concat`, `@text.len`, `@text.cmp`, `@text.contains`, `@text.of_int` —
verified by enumerating `src/comptime/primitives.ts`. There is no way to index,
slice, split, or find an offset in text. `Array.find`, `Iter.map`, `Option.map`
all fail with `no field`. `"a" == "a"` fails with ``"a" is not an integer``,
while the evaluator's message for the same mistake is much better. Every loop
accumulator displays as `(Int | 0)` unless you write a `sig`.

**The build is broken and it is not blot's fault.**
`../gpufuck/src/functional/wasm_codegen.ts:6577` reads `.weakHeadNormalForms` off
`WasmCoreIndex`, which does not exist. `just test` fails to type-check;
`deno test --no-check` gives 246 passed / 6 failed, all six the same gpufuck bug
in `backend.test.ts`. `just build` and `just wasm` are unavailable.
`validateLowering` — gpufuck's CPU oracle, no device, no codegen — works, and it
is the gate every milestone below uses.

---

# Milestones

Ordered by what unblocks the most. M0 is not blot's code and M1 is not a
feature, and both come before the interesting work for the same reason: you
cannot measure a change against a compiler that lies or a test suite that
cannot run.

---

## M0 — Get the build back

**What it unlocks.** Everything. Four of the five milestones below have a
verification gate that mentions `just wasm` or `just test`, and neither runs.

**Work.** File `../gpufuck/src/functional/wasm_codegen.ts:6577` against gpufuck
with the minimal reproduction (any `blot build`; `WasmCompiler.expressionIsWhnf`
reads `.weakHeadNormalForms` off `WasmCoreIndex`, which is undefined at run time
and absent from the type). Do not fix it here; do not pin an older gpufuck — the
pinned copy at `scratchpad/gpufuck-head` is stale against APIs blot now uses.
Add a `just lower` recipe wrapping `validateLowering` so blot has a
device-free, codegen-free backend gate that does not depend on gpufuck's
codegen at all.

**Corpus.** None start compiling; 31 stop being unverifiable end-to-end.

**Gate.** `just test` exits 0. `just wasm` prints "The interpreter, the GPU
evaluator, and the emitted Wasm agree."

**Size.** Zero blot lines plus a bug report; ~15 lines for `just lower`.

---

## M1 — Stop disagreeing with yourself

Four verified defects where blot returns a wrong answer, or the checker and the
evaluator answer differently. Nothing else on this roadmap is worth building on
top of a compiler that does this.

**1a. Refutable patterns must constrain even when another arm is irrefutable.**
`mergeAccepted` (`src/check/infer.ts:743`) returns `null` the moment one arm's
type is a variable, so `constrain(target, covered)` never runs and *no* arm's
binders are connected to the scrutinee. Since `if let` desugars to a `case` with
a `#Some v` arm and a `_` arm, every guard in the language is untyped. Fix: give
`variant` and `record` in `src/check/type.ts` a `permissive` flag meaning
"constrain the members you name, do not error on the ones you do not", build one
from the refutable arms when `mergeAccepted` gives up, and constrain the target
into it. Literal arms must stay non-constraining (`case c of 1 => "one", _ =>
"other" end` applied to text is correct today). This is a monotone upper bound —
no backtracking, no new join, no occurs check; the lattice stays polynomial.

**1b. `:=` in a nested statement scope must be refused.** Add a scan in
`src/syntax/lower.ts` over the loop body's nested statement scopes for a `:=`
naming something not in `carried` and not `let`-bound in that scope; report
`BLOT_REBINDING_NOT_CARRIED` with the fix (`n := if cond then n + 1 else n
end;`). Same check at module and block level. Refuse rather than extend
`carriedNames`: carrying a conditional rebinding out of a branch is a real
language design question and this milestone is not the place to answer it.

**1c. The `if let` success path must reach the result type.** `check` says
`999` where `eval` says `3` when the guard-bound name is returned directly;
`return v + 0;` is correct, so the join is losing exactly the case where the
continuation *is* the bound name. Root-cause in the desugaring
(`src/syntax/lower.ts`) or in the source-function boundary join
(`src/check/infer.ts`); add an inference test pinning `(Int | 999)`.

**1d. A `const` that captures a `let` must refuse in the checker, not at
lowering.** Half done. The language question is decided and said in
`LANGUAGE.md` §4.1: the program is illegal, because a closure whose environment
names a runtime binding is not computable without runtime input. Lowering now
refuses it as `BLOT_CONST_CAPTURES_RUNTIME` at the capture, naming both
bindings, instead of claiming the name is unbound.

What remains is moving the refusal to `check`, so `check` and `eval` stop
accepting a program `build` rejects. That needs a free-variable walk over each
`const` lambda body compared against the comptime environment — machinery the
compiler does not have, and which has to agree with patterns, shadowing, the
`for`/guard desugarings, `open`, handler shapes and `@`-primitives, or it will
over-fire on the corpus. When it lands the code stays the same, and the only
edits are moving this program's `REJECTIONS` stage from `build` to `check` and
deleting the `backend.test.ts` test.

**Corpus.** Adds `examples/rejected/semantics/rebinding_not_carried.blot`,
`.../const_captures_runtime.blot`, and one `examples/` guard program with a
golden. No existing program changes value — verified: all three defects are on
shapes the corpus avoids.

**Gate.** `deno test --allow-read --allow-write` at 246+; the two new rejections
asserting their diagnostic codes in `examples.test.ts`'s `REJECTIONS` table; and
an `examples.test.ts`-style assertion that `blot check` and `blot eval` agree on
the guard program, which is the class of bug 1a and 1c are.

**Size.** ~120 lines for 1a (type.ts, constrain.ts, infer.ts, print.ts), ~60 for
1b, ~20 plus a test for 1c, ~40 for 1d. Small individually; do them together
because they share the `examples/rejected/` churn.

---

## M2 — Make a diagnostic actionable

**What it unlocks.** Every later milestone changes what errors look like, so
this is cheapest now and it compounds. It is also the whole difference between a
language you can plan around and one you keep walking into: bisecting a file by
hand to find a type error was the single largest time cost reported by the agent
who tried to write real programs in blot.

**Work, in dependency order.**

1. **Print the span.** `src/cli.ts:124` does ``console.error(`${path}: ${error.message}`)``
   and drops the diagnostic. `render(path, source,
   diagnostic)` already exists at `src/diagnostic.ts:55` and is already used for
   parse errors at `src/cli.ts:45`. ~25 lines. Do this first; it is the reason
   the rest is worth doing.
2. **Stop the file-wide fallback.** `src/check/mod.ts` re-wraps an escaped
   `TypeError_` with `loaded.module.span`. Give `TypeError_`
   (`src/check/constrain.ts:27`) an optional span so the raising site attaches
   one.
3. **Accumulate.** `fail` throws, so one run reports one error, and
   `src/check/mod.ts` throws `linear.diagnostics[0]` from a list the linearity
   pass had already accumulated correctly — against AGENTS.md's own style rule.
   Make `fail` push and return a poisoned variable; mark it so downstream
   failures against it stay silent, per "a check that cannot infer a type stays
   silent rather than cascading".
4. **Name both sides.** `describe` (`src/check/constrain.ts:52`) collapses every
   non-singleton range to "an integer", giving ``-1 is outside an integer``.
   Route it through `src/check/print.ts`'s renderer: ``-1 is outside 0..``. Same
   for the `fun`/`array` arms that produce "a function is not a function".
5. **Print the name that works.** `src/check/print.ts:364,366` prints `Text`;
   the prelude and `LANGUAGE.md` §10.1 both say `Str`, and `Text` is the
   *namespace record*, so copying the compiler's own output into a `sig` fails
   with `BLOT_SIG_NOT_A_TYPE`. Print `Str`, and make that diagnostic say what
   the expression did evaluate to.
6. **The refusal table.** Give `unsupported()` a second parameter — the
   alternative — and generate a table in `docs/backend.md` from the 26 call
   sites. Where there is no alternative, say so instead of "yet"; "yet" reads as
   "wait for the next release" when the answer is "restructure the program".

**Corpus.** None start compiling. Every rejected example's asserted message
changes, which is the point: `examples.test.ts` asserts codes, so add span
assertions to a representative few.

**Gate.** `deno test`; a new test asserting that `blot check` on a program with
an error on line 62 prints a `:62:` prefix (verified today that the span exists
and is exact — a probe on `checkFile` reports `span=872..879 -> 62:12` for a
diagnostic the CLI prints with no location); and a test asserting two
independent type errors in one file both appear.

**Size.** ~55 lines for items 1, 2, 4, 5 — do those in one afternoon. ~150 for
accumulation. ~140 for the refusal table and its documentation.

---

## M3 — Width subtyping survives lowering

**What it unlocks.** The largest single unblock on this list, and the one with
zero corpus evidence behind it. A `let`-bound function that projects a record is
the most ordinary thing a functional programmer writes, and today it compiles
only when staging can fold the whole call away. Every program that reads runtime
data into a record and passes it to a helper is refused, and the refusal is
`BLOT_LOWERING_BUG` — a bug report filed against gpufuck.

**The decision, and where the judges split.** Three designs were built and
judged three ways.

*Design 2, coercion insertion at the instantiation edge, is rejected outright.*
All three judges ranked it last and one demonstrated a silent miscompile: for
`let orDefault = v => if v.x > 0 then v else { .x = 0; } end;` applied to `{.x=5;
.y=6;}`, the design's own `coreLabels` collapses to `{x}` on both sides of the
instantiation edge, so its `BLOT_UNCOERCIBLE_SHAPE` refusal cannot fire, the
narrowing is emitted, and the Wasm returns `{.x=5}` where the interpreter
returns `{.x=5;.y=6;}`. Its stated central theorem ("every provider of a
component contains every demanded label") was falsified by a four-line program.
It also has no implementation — the scratch tree it claims differs from the repo
in one file, and every byte figure in it came from hand-written gpufuck Core.
A design that rewrites values at run time is the only one of the three that can
break "the three executions agree", and it does.

*Designs 1 and 3 split 2–1 for design 3.* The correctness judge and the cost
judge both picked design 3 (widest-flow shapes: inference decides one nominal
per value, the backend synthesizes nothing). The invariants judge picked design
1 (clone one Core definition per (binding, shape assignment)) and was right
about the two things that make design 3 unshippable as prototyped:

- Design 3's STEP 3 makes `blot check` stack-overflow on a well-typed program
  (`let bump = r => { ...r; .x = r.x + 1; };` reached through `twice`), because
  `flowsIn` resets its cycle guard at every spread hop. Two judges reproduced
  it independently. It takes down the formatter and language-server path.
- Design 3's instantiation registry is a module-level global, so a file's
  inferred nominals depend on which files were checked before it in the same
  process — a direct hit on the reason `load` keeps one cache per process.

And the invariants judge was right that design 3 alone forecloses "monomorphize
before gpufuck" rather than satisfying it: one projector at two shapes stays
refused.

Design 1's own verified fatal problem is that cloning a *binding* duplicates its
effects and its linear consumption. A binding whose value is a block performing
`Console.write "built"` and returning a projecting lambda, called at two shapes,
prints `built` three times from the Wasm and once from the interpreter, and a
linear `!token` consumed once passes `blot ownership` and is then consumed twice
by the clones — `checkLinearity` runs inside `checkFile`, before the
`specialize` slot.

**So: land both, in this order, with the guards the judges found.**

- **M3a — design 3, STEPS 1 and 2 only. Landed.** `freshenAbove` records each
  definition-site variable's copies in a per-`checkModule` `Instances` map
  (`src/check/constrain.ts`), never a module global and never a field on
  `Variable`. `fieldsOf` became `shapeOf` (`src/check/infer.ts`), split by
  polarity — what flowed in decides, demands speak and union only when nothing
  flowed in — and it follows the copies. Two disagreeing flowed sets are carried
  in the fact itself, so the backend refuses with `BLOT_SHAPE_DISAGREEMENT`
  naming both. STEP 3 (the spread-source registration) was dropped as planned;
  it is the verified crash and it costs only the `{ ...r; .x = r.x + 1; }` shape.

  The polarity split was the strongest signal in the whole set: all three
  designs reached it independently, and its regression guard held —
  `examples/modules.blot`'s `.base`/`.bonus` contribute two one-field *upper*
  bounds and still union. The whole corpus emits byte-identical Wasm.

- **M3b — design 1, seeded from M3a's refusals.** A `src/specialize/` pass in
  the empty slot at `src/backend/compile.ts` (between `checkFile` and
  `lowerModule`), returning `(Module', Facts')` so `src/backend/lower.ts` is
  untouched. Seed the worklist **only** from the sites M3a could not pin down,
  not from every `var` occurrence — that is what removes design 1's unmeasured
  path explosion (a 27-line program was measured at over 5,000,000 worklist
  entries under the specified algorithm). Two hard gates:
  - refuse to clone anything but a syntactic lambda or `rec`, which is what
    closes the effect-duplication and linearity-duplication miscompiles;
  - compute the composed per-use field sets inside checking's `pending` closures
    and hand the specializer *label sets*, never live `Variable`s plus an
    exported `fieldsOf`. Walking the constraint graph in a pass outside
    `src/check/` is the second type checker "Inference feeds the backend"
    forbids.

- **M3c — cross-module.** No design closes it and all three prototypes fail
  identically: a projector defined in `examples/lib/` and applied by an importer
  is `F2102` everywhere, because `checkFile` runs each dependency's own
  `checkModule` and its own `pending` before the importer exists. Hoist the
  instantiation registry into `checkFile` and defer every module's `pending`
  until all modules are checked — same reasoning as one `load` cache per
  process. Design 1 named this; take its fix.

Also carry forward, from design 2, the two things it got right that neither
winner states: coercion and nominal construction must map by **label**, never by
position, or `pair.1` silently becomes `pair.0` (`nominal()` keeps `fields` in
first-seen order while keying canonically, so the sorted-set discipline is
load-bearing and needs a test with a tuple projected `.1` before `.0`); and
`lowerHandle` reads its computation and handler as *syntax* through
`Scope.literals` (`src/backend/lower.ts:283`, `:727`), so the specializer needs
an explicit `@handle` carve-out and an example with a handler over a
width-subtyped function.

**Corpus.** None start compiling — all of them already did. What M3a landed
instead is `examples/projected.blot`, which exercises the feature at all: a
runtime source so staging cannot fold it, the bare case, a chain through a
non-projecting caller, a destructuring rather than a projection, and a second
agreeing call site. Its rejection is
`examples/rejected/semantics/shape_disagreement.blot`, asserting the blot-side
code and *not* `BLOT_LOWERING_BUG`. Higher-order through `map` and a returned
record asserting the dropped field survives are still worth adding; a spread of
a width-subtyped parameter waits on the dropped STEP 3.

**Gate.** `deno test --filter "lowers to gpufuck Core"` covering the new
programs; `just wasm` agreeing across all three executions on every one; and
`just test` unchanged at 246+ with `inference.test.ts` byte-for-byte identical,
because M3a adds no constraint and no principal type may move.

**Size.** M3a: ~100 lines across `src/check/constrain.ts`, `src/check/infer.ts`,
`src/check/mod.ts`, plus ~20 lines of resolution and diagnostic in
`src/backend/lower.ts`. M3b: ~250 lines in a new `src/specialize/`. M3c: ~60
lines in `src/check/mod.ts`. Largest milestone here; M3a alone is worth landing
and shipping before M3b starts.

---

## M4 — A program can take text apart

**What it unlocks.** The first wall a real program hits, and a hard one. The
grep case study is only possible because the host hands blot one whole line at a
time. With the current primitives there is no word counter, no tokenizer, no CSV
reader, no argument parser, no template renderer, and no JSON *parser*.

**Work.** Two primitives, and everything else is prelude source:

- `@text.slice text start count` — Unicode-scalar indices matching `@text.len`,
  bounds-checked and trapping like `@array.get`;
- `@text.find text query from` — `#Some index | #None`.

Neither can be written in blot, because blot has no way to observe a code point;
that is what earns them an `@`. Then `Text.at`, `Text.split`, `Text.join`,
`Text.starts_with`, `Text.trim`, `Text.to_int`, `Text.lines` as ordinary prelude
source. Alongside them, the combinators a first page reaches for and does not
find: `Array.find`, `Array.concat`, `Array.reverse`, `Option.map`/`and_then`,
`Result.map`/`and_then`/`unwrap_or` (`Result` today is three constructors and
zero combinators, which is the honest reason it appears in the unused-exports
list), and `Iter.map`/`filter`/`take`/`enumerate` — the iterator protocol the
prelude is proud of has no combinators over it. `Iter.map` over the
`{ .state; .step; }` shape stays one closure total.

Also here, because they are the same class of "the language does not do the
obvious thing": `"a" == "a"` fails with ``"a" is not an integer`` while the
evaluator's message for the identical mistake names `Text.cmp` and is much
better. Minimum viable is to make the checker's message match the evaluator's.
The full answer — one comparison entry point that reflects on its argument's
type, which `refines` already does — is a prelude change, not a lattice change.

**Corpus.** Adds `examples/text.blot` with a golden, and the case studies gain a
fourth: a word-frequency counter or a small tokenizer, which is currently
impossible to write. `LANGUAGE.md` §13.2 and §14 change in the same diff.

**Gate.** `just test` (goldens); `deno test --filter "lowers to gpufuck Core"`
on the new example; `just wasm` on it, because the two new intrinsics must be
self-contained in emitted Wasm the way `@text.len` already is — there is a test
for exactly that at `backend.test.ts:179`.

**Size.** ~120 lines for the two primitives (comptime + Wasm intrinsic) plus
~150 lines of prelude and spec. The prelude combinators are another ~150 and can
land independently.

---

## M5 — The type a loop accumulator actually has

**What it unlocks.** The two places inference is precise and then throws the
precision away at the point a human or the ABI reads it, plus the one place it
is too strict to write the obvious loop.

**5a. Subsume and head-merge a variable's bounds when printed.** At least 45
displayed unions across `examples/` and `case-studies/` are redundant —
`examples/loops.blot` shows `.counted = (Int | 0)`, `.joined = (Text | "")`,
`.doubled = ([Int] | ['a])`; `case-studies/grep/main.blot` infers `(Int | 0) ~ {
Arguments, Console, File }` for a program that returns a count. Verified that
the lattice already agrees: adding `sig total = Int;` makes the same program
print `Int`. `src/check/print.ts:94` dedupes by rendered string, so `0` and
`Int` both survive. Add range subsumption (but never lub disjoint ranges — `(0 |
10)` in `examples/linear.blot` must stay) and head merging for `array` and
`variant` bounds. Then delete the hand-rolled duplicate of this in
`src/backend/lower.ts`'s `exportSchema`, which exists only because the checker
hands the backend an unnormalized bound list. Free — a read-time coalescing
rule, not a constraint rule. `for` is blot's flagship desugaring and it makes
every accumulator look untyped.

**5b. Widen constructor singletons on `:=`.** `let f = True; f := False;` is
refused — ``must preserve #True, found #False`` — and even an explicit `sig f =
Bool;` does not help, because `#False` is a strict subtype of `#True | #False`.
A boolean flag is the most common loop accumulator there is. Extend `LANGUAGE.md`
§4.3's widening from integer and text singletons to constructor sets: widen both
sides to the union of their case sets before the mutual constraint. The stable-
type guarantee survives — the accumulator's type is still fixed for the whole
loop, it is just the union rather than whichever case was written first.
`examples/rejected/semantics/for_type_drift.blot` stays rejected, because `Int`
and `Text` are different domains and that is the case the invariant protects.

**5c. Give the loop-lowered `:=` failure the good message.** The identical defect
reads ``#A is not one of #B`` inside a `for` and ``` `s := ...` must preserve #A,
found #B. Use `let s = ...;` ... ``` outside one, because inside a loop the `:=`
has already become a record field by the time inference sees it. Carry the
accumulator field's source name and the `:=` span through the lowering —
`carriedNames` already produced the name.

**Corpus.** No new programs; ~45 golden union strings and 6 `inference.test.ts`
strings move, all in the good direction. `examples/loops.blot` and
`examples/breaking.blot` gain a boolean accumulator.

**Gate.** `just test` with the updated goldens; the diff on
`inference.test.ts:123`/`:129` (`"Int -> (Int | 0 | -1)"` and `"Int -> (Int |
0)"`) is the evidence, so review it rather than regenerating it.

**Size.** ~80 lines in `print.ts` plus a `subsumes` helper, ~40 deleted from
`lower.ts`; ~50 lines for 5b plus `LANGUAGE.md` §4.3; ~30 for 5c.

---

## M6 — `struct` is typed, and `@shape.get` learns from a literal

**What it unlocks.** `struct` is the prelude's storage feature, a third of
`examples/storage.blot`, and it is completely untyped at its use sites. Verified:
`const P = struct { .x = I32; .y = I32; }; let p = P.new {...}; Text.append (P.x
p) "oops"` **checks** as `Text` and traps at run time. `examples/storage.blot`
has eight export fields inferred as bare variables (`.origin = 'a`) while
`.by_position = somewhere.0` — the same slot by ordinary projection — infers a
range. Two halves, and either alone buys almost nothing:

**6a.** `@shape.get target name` with a compile-time-known `name`. Verified today
that `@shape.get r "x"` on `{ .x = 10; .y = "hi"; }` infers `'a` while `r.x` on
the next line infers `10`, and that `@shape.get r "nope"` is accepted by the
checker. `inferSpecial` (`src/check/infer.ts:432`) already exists for primitives
whose type depends on their argument, and `comptime(expr, context)` already
returns `null` when it cannot evaluate. Emit the same record constraint the
`field` case emits; fall through to today's scheme when `comptime` returns null,
because the prelude has five genuinely dynamic uses that must keep working.

**6b.** Infer a compile-time closure member from its lambda in its captured
environment. `src/check/infer.ts:286` gives up because `bridge` returns null for
every closure — but a comptime closure value already carries `parameter`, `body`,
and `env` (`src/comptime/value.ts:29`). Build a `Context` from the captured env
and run the ordinary lambda rule; memoize on the closure with a `WeakMap`, and
guard re-entry explicitly so a self-referential comptime closure cannot loop the
checker. With 6a, `Point.x`'s body `@shape.get value (key name)` sees `key name`
evaluate to `"0"` and infers `{ .0 = 'a; } -> 'a`.

**Corpus.** `examples/storage.blot`'s eight variable fields and
`examples/reflect.blot`'s `.label_at`/`.built` become concrete. Adds
`examples/rejected/` for `@shape.get r "nope"`. Retires the second bullet of
`LANGUAGE.md` §10.3.

**Gate.** `just test`; `deno test --filter "lowers to gpufuck Core"` on
`storage.blot` and `reflect.blot`, whose ABI manifest for those exports stops
depending on `bridgeRuntimeValue` reading the constant value — that is the
substantive change and it must not move `docs/abi.md`'s contract.

**Size.** ~40 lines for 6a, ~90 for 6b. Depends on M2 (the messages change) and
is much easier after M3a (the same `fieldsOf` polarity split).

---

## M7 — Tooling: a formatter, and diagnostics an editor can consume

**What it unlocks.** `docs/editor.md:15` says "There is no language server yet;
that arrives with the inference milestone." Inference arrived. The line is
stale, `blot fmt` is not a command, and `parse()` cannot feed a formatter today:
it returns `{ ok, module }` only, the baba cursor is a local at
`src/syntax/parse.ts:46`, and nothing in `src/syntax/ast.ts` carries comments or
trivia — so a formatter reconstructed from the AST would delete every comment in
the file, including the 700 lines of design commentary in the prelude.

**Work.** Export a second entry point from `src/syntax/parse.ts` returning the
cursor alongside the module, and attach comment tokens as leading/trailing
trivia during `lowerModule`. Every node already carries an exact `span`, so a
printer can reprint from spans; what it cannot do is find the comments. Then the
printer. The language server needs nothing else that M2's diagnostic
accumulation does not already provide: `CheckResult` already carries `opens`,
`values`, `shapes`, `variants`, and `grants` keyed by AST node identity, which is
what hover and go-to-definition want, and `blot check` is verified device-free.

Also here, because it is the same complaint from the other end: parse
diagnostics carry no expectation. Every syntax mistake reports `Unexpected token
";"`, including the omitted `else` on an expression `if` — the language's most
emphatic rule. A missing comma between `case` arms reports `BLOT_BAD_PARAMETER`.
A missing `;` after `let x = 1` reports `BLOT_MISSING_RESULT` at 1:1 for an error
on line 2, and the claim is false. Surfacing baba's admissible-token set at the
failure state is the real fix and a baba question; a table of recovery patterns
keyed on (failing rule, unexpected token) needs no baba change.

**Corpus.** `deno fmt --check` gains `blot fmt --check` over the whole corpus,
which is a stronger parity statement than `just parity` alone: reprinting every
program and reparsing it must give the same AST *and* the same comment
placement.

**Gate.** A round-trip test: `blot fmt` every `.blot` file in the repo, reparse,
assert the module is structurally identical and no comment was lost. `just
grammar-check` and `just parity` unchanged, since none of this touches
`grammar.baba`.

**Size.** ~80 lines for trivia capture, ~400 for a printer, ~100 for parse
recovery patterns. The LSP itself is a separate project on top of `checkFile`
and is out of scope for this repo.

---

## M8 — `blot eval` can run a program that reads input

**What it unlocks.** Verified: `src/run.ts:50` is `if (perform.effectName ===
"Console" && perform.operation === "write")` and everything else returns null.
Rename a host effect from `Console` to `Output` and the identical program stops
running. `Terminal.read_line`, `File.line`, `Arguments.pattern`, `Model.complete`
— every host effect in the three case studies — cannot be run by the CLI at all.
They run only through `case-studies/run.ts`, 181 lines of bespoke TypeScript.
There is no way to write a blot program that reads input and run it without
writing TypeScript, and the refusal blames the user for a missing handler when
the user did exactly what `LANGUAGE.md` §12.3 prescribes. This directly
contradicts `docs/backend.md`'s own line that an effect's identity is its own,
not its spelling.

**Work.** Bind a small set of well-known operation shapes selected by CLI flag
rather than by effect *name*: `Unit -> Str` from stdin, `Str -> Unit` to stdout,
`Unit -> Int`/`Int -> Str` over a file argument. `checkFile` already returns the
grants and the module row, so the runner knows what to bind. Until that exists,
the message must name the mechanism:
``BLOT_NO_HOST_IMPLEMENTATION: `Output.write` is a host effect; `blot eval`
only implements `Console.write`.``

**Corpus.** The three case studies become runnable with `blot eval`, retiring
most of `case-studies/run.ts`. That is the point: the case studies are the best
usability evidence in the repo and they currently require a bespoke harness.

**Gate.** `deno test` including `case-studies/case_studies.test.ts` with the
harness replaced by `blot eval` invocations.

**Size.** ~15 lines for the message; ~150 for the generic runner across
`src/run.ts` and `src/cli.ts`, minus ~150 retired from `case-studies/run.ts`.

---

## Deliberately deferred, with reasons

**Range-refining arithmetic and comparison narrowing.** `docs/inference.md`
names this as the honest gap and it is real — there is no signature over
arithmetic other than `Int`, so every width claim in a program that computes
must be abandoned, and `return 2 + 3;` infers `Int` while `const x = 2 + 3;`
infers `5`. Moving `@int.add`/`sub`/`mul` into `inferSpecial` and adding a
comparison recognizer is ~160 lines and would tighten many types. It is deferred
below M5 because it makes `inference.test.ts` and every example golden move at
the same time as M5 does, and doing both at once makes neither reviewable. It
also needs a widening cap for a range refined inside recursion, which is a new
kind of termination argument in the checker.

**Array length in the lattice.** ~250 lines across six files, the largest of the
inference items and the weakest payoff-to-risk ratio. It closes literal, `push`,
and spread indices. It does **not** close `@array.get xs i` inside `for i in
Iter.range (0, @array.len xs)`, which needs `i` linked to *this* array's length
variable — a dependent relationship the lattice cannot express. Do it after M5
and M6, or not at all; say so in `LANGUAGE.md` §10.3 rather than implying it is
coming.

---

# What blot will not do

A roadmap that keeps every option open is not a plan. These are refusals, not
"not yet".

**No second backend and no CPU parser fallback.** gpufuck owns Core-to-Wasm;
baba owns lexing and parsing. A gpufuck rejection on a well-typed blot program is
a lowering bug in blot, and it will keep being reported as one.

**No coercion inserted at instantiation edges.** Design 2 is closed, not
shelved. Narrowing a record's value to fit a nominal is observable whenever the
parameter can reach the result, the comptime evaluator does not narrow, and a
verified program exists where the emitted module silently drops a field the
interpreter keeps. Re-widening from the saved argument is unsound for the
symmetric reason — the result's `.y` is not provably the argument's `.y`. That
reasoning belongs in `docs/backend.md` so the next person does not rediscover it
as a shortcut.

**No monomorphizing everything.** M3 duplicates only where the alternative is a
hard compile failure. Core stays polymorphic wherever gpufuck's HM can type it,
and the unit test for that is a clone *count*, not "it compiles".

**No `Store` element coercion.** Priced at an O(n) copy per call. Refuse it by
name.

**No assignment, and no widening of `for` to carry a conditional rebinding.**
M1b refuses `n := ...` inside a statement `if` rather than making it work.
Ownership analysis assumes there is no mutation, and a `:=` whose effect depends
on a branch is the beginning of one.

**No type-level sublanguage.** No `type`, `interface`, `effect`, or `duck`
declaration forms; no type namespace. If a feature seems to need one it belongs
in the comptime evaluator.

**No implicit prelude scope.** `open {} = (@import "blot:prelude") ();` stays on
the first line of every program. A default fixity naming a binding by string is
the mechanism, and it is not going to be hidden.

**No equi-recursive types in the lattice.** `const Json = #Null | #Num Int |
#Arr [Json];` will keep being refused. A recursive datatype can be structural
but never *named*, so it can never appear in a `sig` and — since
`LANGUAGE.md` §15 requires a concrete first-order type — never be exported.
State this in `LANGUAGE.md` §10 next to the `const Message = ...` example; do
not attempt the lattice change.

**No mutual recursion without a grammar decision.** `rec` binds one name;
`const is_even = rec (...); const is_odd = rec (...)` dies on `BLOT_UNBOUND`.
The minimum is a diagnostic that distinguishes "not in scope" from "not in scope
*yet*" and names the limit. `rec` over a group is a grammar change and therefore
a GPU-profile question; price it separately, and remember that AGENTS.md treats
a profile conflict as a design signal, not a metadata override.

**No impredicative instantiation.** `@forall` is explicit and predicative and
stays that way.

**No general index-bounds proof.** The loop-index case stays listed as a
deliberate limit in `LANGUAGE.md` §10.3. `@array.get` and `@text.slice` trap.

**No language server in this repository.** `checkFile` will expose everything an
LSP needs — a diagnostic *list* with exact spans, plus the fact maps keyed by
node identity — and the LSP itself is somebody else's project. The invariant
that matters here is that `blot check` never initializes a device, and that is
verified to hold today.

**No fixing `../gpufuck`.** File the bug.

---

## Documentation debt, to be paid inside the milestones that cause it

`AGENTS.md` requires `LANGUAGE.md` to change in the same diff as the language.
Four documents currently overlap and three carry claims I verified to be false:

- `docs/backend.md`'s "Width subtyping is specialized before Core" section
  describes a corpus failure that no longer reproduces; M3 rewrites it around
  the *staging* explanation and the runtime-source reproduction.
- `docs/inference.md`'s rank-N paragraph is now correct — but no example
  exercises it. M3 or M1 adds `examples/rankn.blot` plus the `run2 (x => 42)`
  rejection, per the one-program-per-feature catalog rule.
- `docs/editor.md:15` promises a language server "with the inference milestone".
  M7 corrects it.
- `README.md`'s "M4 now lowers every accepted catalog program" is true and
  misleading in the same sentence; M3 qualifies it with what the catalog does
  not contain.

Merge `docs/inference.md`'s operator table and `docs/backend.md`'s refusal list
into `LANGUAGE.md` where they are normative, and leave the `docs/` files as
rationale. The 17 prelude exports unused outside the prelude are not API bloat
to prune: `Result` is unused because it has no combinators (M4 fixes that),
`Bool`/`Option`/`Ordering`/`Array`/`Iter` are namespaces a user needs even when
the corpus does not, and `unseal`/`union_of`/`flip`/`compose` are the kind of
thing a catalog should demonstrate. The right fix is an example per unused
export, not a smaller prelude.
