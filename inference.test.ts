// Principal types, asserted as strings.
//
// This is the point of writing them down: a lattice change that widens an
// inferred type shows up here as a diff rather than as "still compiles". A test
// that only checked "no error" would pass just as happily with a checker that
// inferred `⊤` for everything.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { checkFile, checkUncheckedSource } from "./src/check/mod.ts";
import { BlotError, render } from "./src/diagnostic.ts";
import { LoadError } from "./src/load.ts";

const scratch = await Deno.makeTempDir();

// Every snippet opens the prelude, because every module does: it has no
// privilege, and a fixture that skipped it would be testing a language where
// `+` is unbound.
const PRELUDE = `open import "blot:prelude"
`;

async function typeOf(source: string): Promise<string> {
  const path = `${scratch}/case_${crypto.randomUUID()}.blot`;
  const checked = await checkUncheckedSource(path, PRELUDE + source);
  return checked.type;
}

async function errorOf(source: string): Promise<string> {
  const path = `${scratch}/case_${crypto.randomUUID()}.blot`;
  try {
    await checkUncheckedSource(path, PRELUDE + source);
  } catch (error) {
    if (error instanceof BlotError || error instanceof LoadError) {
      return error.message;
    }
    throw error;
  }
  throw new Error("expected this program to be rejected");
}

function check(name: string, source: string, expected: string): void {
  Deno.test(name, async () => {
    assertEquals(await typeOf(source), expected);
  });
}

function rejects(name: string, source: string, fragment: string): void {
  Deno.test(name, async () => {
    assertStringIncludes(await errorOf(source), fragment);
  });
}

Deno.test("checking retains expression types for backend lowering", async () => {
  const path = `${scratch}/case_${crypto.randomUUID()}.blot`;
  await Deno.writeTextFile(
    path,
    `${PRELUDE}let answer = 40 + 2
export answer
`,
  );
  const checked = await checkFile(path);
  if (checked.expressionTypes.size === 0) {
    throw new Error("checking omitted every inferred expression type");
  }
});

Deno.test("direct array access carries an explicit proof certificate", async () => {
  const path = `${scratch}/case_${crypto.randomUUID()}.blot`;
  await Deno.writeTextFile(
    path,
    `${PRELUDE}let values = [42]
export @array.get values 0
`,
  );
  const checked = await checkFile(path);
  assertEquals(checked.arrayProofs.size > 0, true);
  for (const proof of checked.arrayProofs.values()) {
    assertEquals(proof.tag, "array-index");
  }
  assertEquals(coreCarriesArrayProof(checked.core), true);
});

function coreCarriesArrayProof(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (
    "arrayProof" in value && value.arrayProof !== null &&
    typeof value.arrayProof === "object" && "tag" in value.arrayProof &&
    value.arrayProof.tag === "array-index"
  ) return true;
  for (const member of Object.values(value)) {
    if (coreCarriesArrayProof(member)) return true;
  }
  return false;
}

Deno.test("generative effect identities are recorded once per declaration", async () => {
  const checked = await checkFile("./examples/shadowed_effects.blot");
  const effects = [...checked.comptimeValues.values()].filter((value) =>
    value.tag === "effect" && value.name === "Log"
  );
  assertEquals(effects.length, 2);
  const identities = effects.map((effect) => {
    if (effect.tag !== "effect") throw new Error("expected an effect");
    return effect.id;
  });
  assertEquals(new Set(identities).size, 2);
});

check(
  "a deferred parameter appears in the inferred arrow",
  `const lazy = fn ~value => value
export lazy
`,
  "~'a -> 'a",
);

check(
  "a deferred arrow can be written in a signature",
  `sig lazy = ~Int -> Int
const lazy = fn ~value => value
export lazy 42
`,
  "Int",
);

rejects(
  "a strict implementation does not satisfy a deferred arrow",
  `sig lazy = ~Int -> Int
let lazy = fn value => value
export lazy
`,
  "function",
);

rejects(
  "a deferred argument must be pure",
  `const Console = @effect { .write = Str -> Unit; }
const lazy = fn ~value => value
export lazy (Console.write "hello")
`,
  "deferred argument",
);

// --- literals are singleton types -------------------------------------------

check(
  "an integer literal is its own type",
  `export 42
`,
  "42",
);

check(
  "Length accepts array and text implementations structurally",
  `sig measure_array = Length [Int] -> [Int] -> Int
let measure_array = fn implementation => fn values => implementation.length values
sig measure_text = Length Str -> Str -> Int
let measure_text = fn implementation => fn value => implementation.length value
export (measure_array Array [1, 2, 3], measure_text Text "blot")
`,
  "(Int, Int)",
);

check(
  "a float literal is not a singleton",
  `export 1.5
`,
  "F64",
);

check(
  "a seal is applicative in its name and carrier",
  `const First = seal ("Token", I32)
const Second = seal ("Token", I32)
sig same = #True
const same = refines (First, Second)
export same
`,
  "#True",
);

check(
  "float arithmetic stays in the one float type",
  `open import "blot:prelude"
export Float.add 1.5 2.5
`,
  "F64",
);

check(
  "a float has no equality, only an ordering that refuses NaN",
  `open import "blot:prelude"
export { .same = is_equal (Float.cmp 0.5 0.5); .nan = Float.is_nan 1.0; }
`,
  "{ .same = (#True | #False); .nan = #True | #False; }",
);

check(
  "a four-lane vector is an opaque type, not a range",
  `open import "blot:prelude"
export Vec4.splat (Float32.of_int 1)
`,
  "F32x4",
);

check(
  "a lane read leaves the vector for the scalar type",
  `open import "blot:prelude"
export Vec4.x (Vec4.splat (Float32.of_int 1))
`,
  "F32",
);

check(
  "integer lane width is part of the vector type",
  `export Int16x8.add (Int16x8.splat 1) (Int16x8.splat 2)
`,
  "I16x8",
);

check(
  "integer comparisons produce a width-specific mask",
  `export Int8x16.less_unsigned (Int8x16.splat 1) (Int8x16.splat 2)
`,
  "I8x16Mask",
);

rejects(
  "integer vectors with different lane widths do not mix",
  `export Int32x4.add (Int32x4.splat 1) (Int16x8.splat 2)
`,
  "BLOT_TYPE_ERROR",
);

rejects(
  "literal arms cannot cover a vector",
  `open import "blot:prelude"
sig f = F32x4 -> Int
let f = fn v => case v of
  1 => 1
export f (Vec4.splat (Float32.of_int 1))
`,
  "BLOT_INCOMPLETE_CASE",
);

check(
  "single precision is its own type",
  `open import "blot:prelude"
export Float32.mul (Float32.of_int 2) (Float32.of_float 1.5)
`,
  "F32",
);

rejects(
  "the two float precisions do not mix",
  `open import "blot:prelude"
export Float.add 1.5 (Float32.of_int 1)
`,
  "BLOT_TYPE_ERROR",
);

check(
  "crossing between the numeric types is explicit and exact",
  `open import "blot:prelude"
export { .up = Float.of_int 7; .down = Float.truncate 3.75; }
`,
  "{ .up = F64; .down = Int; }",
);

rejects(
  "a float case is never exhaustive on its own",
  `open import "blot:prelude"
sig pick = F64 -> Int
let pick = fn x => case x of
  1.5 => 1
export pick 1.5
`,
  "BLOT_INCOMPLETE_CASE",
);

rejects(
  "the two numeric types do not mix",
  `open import "blot:prelude"
export Float.add 1.5 2
`,
  "BLOT_TYPE_ERROR",
);

check(
  "identity preserves the singleton",
  `let identity = fn x => x
export identity 42
`,
  "42",
);

check(
  "arithmetic widens to the domain, because it cannot prove a width",
  `export @int.add 20 22
`,
  "Int",
);

// --- functions and let-polymorphism -----------------------------------------

check(
  "identity is polymorphic",
  `let identity = fn x => x
export identity
`,
  "'a -> 'a",
);

// --- declaration tags ------------------------------------------------------

check(
  "a declaration tag may replace the binding value and its type",
  `const text = tag ("text", (), (fn _ => "changed"))
@[text] let value = 1
export value
`,
  '"changed"',
);

check(
  "stacked declaration tags apply nearest-first",
  `const add = fn n => tag ("add", n, (fn value => value + n))
@[add(1)] @[add(2)] let value = 3
export value
`,
  "Int",
);

check(
  "a declaration tag transforms before its binding pattern matches",
  `const pair = tag ("pair", (), (fn _ => (1, "two")))
@[pair] let (number, text) = ()
export { .number = number; .text = text; }
`,
  '{ .number = 1; .text = "two"; }',
);

rejects(
  "a declaration tag descriptor must be a shape",
  `@[1] let value = 2
export value
`,
  "BLOT_BAD_DECLARATION_TAG",
);

rejects(
  "a declaration tag descriptor transform must be callable",
  `@[{ .name = "broken"; .metadata = (); .transform = 1; }]
let value = 2
export value
`,
  "BLOT_BAD_DECLARATION_TAG",
);

rejects(
  "a declaration tag descriptor must be known before a local binding",
  `let tagged = fn descriptor =>
  @[descriptor] let value = 1
  return value
export tagged test
`,
  "BLOT_NOT_COMPTIME",
);

check(
  "one binding instantiates independently per use",
  `let identity = fn x => x
export { .a = identity 1; .b = identity "two"; }
`,
  '{ .a = 1; .b = "two"; }',
);

check(
  "rebinding preserves the integer domain",
  `let value = 1
value := 2
export value
`,
  "Int",
);

rejects(
  "rebinding rejects a different type",
  `let value = 1
value := "two"
export value
`,
  "Use `let value = ...;`",
);

check(
  "a repeated let may shadow with a different type",
  `let value = 1
let value = "two"
export value
`,
  '"two"',
);

check(
  "rebinding preserves polymorphism",
  `let identity = fn x => x
identity := fn x => x
export { .number = identity 1; .text = identity "two"; }
`,
  '{ .number = 1; .text = "two"; }',
);

check(
  "an unconditional return determines its block result",
  `let answer = fn () =>
  return 42
export answer
`,
  "() -> 42",
);

check(
  "a statement conditional returns from its surrounding block",
  `let describe = fn value =>
  if value < 0:
    return "negative"
  return "positive"
export describe
`,
  'Int -> ("negative" | "positive")',
);

check(
  "a return crosses a for loop",
  `let find = fn wanted =>
  for value in Iter.range (0, 5):
    if value == wanted:
      return value
  return -1
export find
`,
  "Int -> (Int | 0 | -1)",
);

check(
  "a return crosses an unbounded loop",
  `let count_to = fn limit =>
  let count = 0
  for ever:
    count := count + 1
    if count >= limit:
      return count
  return 0
export count_to
`,
  "Int -> (Int | 0)",
);

check(
  "a value if keeps a nested return inside its result scope",
  `let answer = fn () =>
  let inner = case 1 < 2 of
    #True => do:
      return 41
    #False => 0
  return inner + 1
export answer
`,
  "() -> Int",
);

check(
  "a value case keeps a nested return inside its result scope",
  `let answer = fn () =>
  let inner = case Some 41 of
    #Some value =>
      return value

    #None => 0
  return inner + 1
export answer
`,
  "() -> Int",
);

rejects(
  "rebinding requires an existing name",
  `missing := 1
export missing
`,
  "cannot shadow a name that is not in scope",
);

check(
  "a curried section keeps its remaining parameter",
  `let add = fn a => fn b => @int.add a b
export add 2
`,
  "Int -> Int",
);

// Not `('a -> 'a) -> 'a -> 'a`. Hindley-Milner has to unify the two uses of `f`;
// with subtyping the principal type is their intersection, which is strictly
// more general. Writing the expected string down is what caught the assumption.
check(
  "applying a parameter twice intersects its two uses",
  `let twice = fn f => fn x => f (f x)
export twice
`,
  "('a -> 'b & 'b -> 'c) -> 'a -> 'c",
);

// --- records: width subtyping is the whole of a `duck` contract --------------

check(
  "a projection constrains only the field it reaches for",
  `let width = fn shape => shape.w
export width
`,
  "{ .w = 'a; } -> 'a",
);

check(
  "two projections accumulate one record constraint",
  `let area = fn s => @int.mul s.w s.h
export area
`,
  "{ .w = Int; .h = Int; } -> Int",
);

rejects(
  "a missing field is an ordinary constraint failure",
  `let area = fn s => @int.mul s.w s.h
export area { .w = 2; }
`,
  "no field `.h`",
);

check(
  "an optional field supplies unit when it is omitted",
  `sig count = { .value? = Int; } -> Int
let count = fn properties => case properties.value of
  () => 0
  value => value
export count {}
`,
  "Int",
);

Deno.test("an omitted optional field records its call-site coercion", async () => {
  const path = `${scratch}/case_${crypto.randomUUID()}.blot`;
  await Deno.writeTextFile(
    path,
    `${PRELUDE}sig count = { .value? = Int; } -> Int
let count = fn properties => case properties.value of
  () => 0
  value => value
export count {}
`,
  );
  const checked = await checkFile(path);
  const adaptation = [...checked.recordAdaptations.values()].find((candidate) =>
    candidate.sourceFields.length === 0 &&
    candidate.fields.length === 1 &&
    candidate.fields[0].name === "value"
  );
  if (adaptation === undefined) {
    throw new Error("checking omitted the optional-field record adaptation");
  }
  assertEquals(adaptation.fields[0].optional, "absent");
});

// --- variants, unions, and narrowing ----------------------------------------

check(
  "a case joins its arms",
  `let f = fn m => case m of
  #Ready => 1
  #Failed r => r
export f
`,
  "#Ready | #Failed 'a -> ('a | 1)",
);

check(
  "a pinned pattern keeps the existing binding and joins its arms",
  `let wanted = 1
let choose = fn actual => case actual of
  ^wanted => "yes"
  _ => "no"
export choose
`,
  'Int -> ("yes" | "no")',
);

rejects(
  "a pinned pattern does not make a case exhaustive",
  `let wanted = 1
sig choose = Int -> Str
let choose = fn actual => case actual of
  ^wanted => "yes"
export choose
`,
  "BLOT_INCOMPLETE_CASE",
);

rejects(
  "a pinned pattern requires an existing binding",
  `export case 1 of
  ^missing => "yes"
  _ => "no"
`,
  "BLOT_UNBOUND",
);

rejects(
  "a pinned pattern requires a scalar equality domain",
  `let wanted = [1]
export case [1] of
  ^wanted => "yes"
  _ => "no"
`,
  "BLOT_UNMATCHABLE_PIN",
);

rejects(
  "a pinned parameter needs a known scalar type",
  `let matches = fn expected => fn actual => case actual of
  ^expected => 1
  _ => 0
export matches
`,
  "BLOT_UNMATCHABLE_PIN",
);

rejects(
  "a nested pin must share the matched value's scalar domain",
  `let wanted = "one"
sig choose = (Int, Int) -> Str
let choose = fn pair => case pair of
  (^wanted, _) => "yes"
  _ => "no"
export choose
`,
  "BLOT_TYPE_ERROR",
);

check(
  "an unmatched branch keeps the parameter open",
  `let f = fn (flag, other) => case flag of
  #No => #Off
  #Yes => other
export f
`,
  "(#No | #Yes, 'a) -> ('a | #Off)",
);

check(
  "a default arm still types the constructor arms it accompanies",
  `let f = fn m => case m of
  #Some inner => inner
  _ => 0
export f
`,
  "#Some 'a | .. -> ('a | 0)",
);

check(
  "an open union accepts a constructor no arm names",
  `let f = fn m => case m of
  #Some inner => inner
  _ => 0
export f (#Some "hi")
`,
  '(0 | "hi")',
);

check(
  "a name arm is the target",
  `let f = fn m => case m of
  other => other
export f
`,
  "'a -> 'a",
);

check(
  "a guard types what it binds",
  `let f = fn m =>
  if let #Some inner = m else:
    return "none"
  return inner
export f (#Some 7)
`,
  '("none" | 7)',
);

rejects(
  "a guard rejects a payload used at the wrong type",
  `let f = fn m =>
  if let #Some inner = m else:
    return "none"
  return Text.append inner "!"
export f (#Some 3)
`,
  "`3` is not `Str`",
);

rejects(
  "a constructor no arm covers is rejected",
  `let f = fn m => case m of
  #Ready => 1
  #Busy n => n
export f (#Failed "x")
`,
  "`#Failed` is not one of",
);

rejects(
  "a declared literal union rejects a value outside it",
  `sig level = 1 | 2 | 3
let level = 7
export level
`,
  "`7` is not one of `1` | `2` | `3`",
);

// --- a literal union is a set the arms must exhaust -------------------------
//
// A constructor set is covered by subtyping, because a variant of the arms is a
// type. A literal set is covered by membership instead: the arms are checked
// against the declared members rather than constrained to them, so an
// unannotated scrutinee stays unconstrained and only a declared one carries a
// requirement.

rejects(
  "a literal no arm covers is rejected",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n => case n of
  1 => "one"
export f
`,
  "No arm covers `2 | 3`",
);

rejects(
  "a text literal no arm covers is rejected",
  `sig f = "up" | "down" -> Int
let f = fn d => case d of
  "up" => 1
export f
`,
  'No arm covers `"down"`',
);

check(
  "arms that exhaust a literal union are accepted",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n => case n of
  1 => "one"
  2 => "two"
  3 => "three"
export f
`,
  "1 | 2 | 3 -> Str",
);

check(
  "an irrefutable arm covers the rest of a literal union",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n => case n of
  1 => "one"
  _ => "rest"
export f
`,
  "1 | 2 | 3 -> Str",
);

rejects(
  "literal arms over an unconstrained target require a fallback",
  `let f = fn n => case n of
  1 => "one"
  2 => "two"
export f
`,
  "not known well enough",
);

rejects(
  "an unbounded domain cannot be covered by literal arms",
  `sig f = Int -> Str
let f = fn n => case n of
  1 => "one"
export f
`,
  "BLOT_INCOMPLETE_CASE",
);

check(
  "a `_` arm covers what literals cannot, and `@panic` says why it is unreachable",
  `sig f = Int -> Str
let f = fn n => case n of
  1 => "one"
  _ => @panic "not one"
export f
`,
  "Int -> Str",
);

check(
  "a literal payload arm leaves its constructor set alone",
  `let f = fn m => case m of
  #Some 1 => "one"
  #Some n => "many"
  #None => "none"
export f (#Some 2)
`,
  '("one" | "many" | "none")',
);

// --- a guarded arm is not one the matrix can count on -----------------------
//
// A guard is a refinement no pattern states, so an arm carrying one is taken
// only when its guard also holds. Coverage therefore reads the arms with the
// guarded ones removed: they cannot be the arm that matches, and a row that
// cannot match must not close a column. Everything below is that one rule seen
// from a different side.

rejects(
  "a guarded arm does not cover the literal it names",
  `sig f = 1 | 2 -> Str
let f = fn n => case n of
  1 => "one"
  m if m > 1 => "big"
export f
`,
  "No arm covers `2`",
);

rejects(
  "a `case` whose arms are all guarded covers nothing",
  `let f = fn n => case n of
  m if m > 0 => "up"
  m if m < 0 => "down"
export f
`,
  "No arm of this `case` can be the one that matches",
);

rejects(
  "a guarded arm does not close a constructor set",
  `let f = fn o => case o of
  #Some n if n > 0 => "big"
  #None => "none"
export f (#Some 1)
`,
  "`#Some` is not one of #None",
);

check(
  "an unguarded arm below a guarded one is what covers the set",
  `let f = fn o => case o of
  #Some n if n > 0 => "big"
  #Some _ => "small"
  #None => "none"
export f (#Some 1)
`,
  '("big" | "small" | "none")',
);

check(
  "the arms above a guard keep their priority",
  `sig f = 1 | 2 -> Str
let f = fn n => case n of
  1 => "one"
  m if m > 1 => "big"
  _ => "rest"
export f 2
`,
  "Str",
);

// A tuple target is read the same way: the rows that cover the cross-product
// are the unguarded ones, so the combination this guards is a combination no
// arm covers.
rejects(
  "a guarded row does not cover a column combination",
  `sig join = (Option Int, Option Int) -> Int
let join = fn pair => case pair of
  (#Some a, #Some b) => a + b
  (#Some a, #None) => a
  (#None, #Some b) => b
  (#None, #None) if 1 > 0 => 0
export join (None, None)
`,
  "No arm covers `(#None, #None)`",
);

// The guard is an ordinary condition in the arm's own scope: it reads what the
// pattern bound, and it has to be a `Bool` like every other condition.
rejects(
  "a guard that is not a condition is rejected",
  `let f = fn n => case n of
  m if m => "yes"
  _ => "no"
export f 1
`,
  "BLOT_TYPE_ERROR",
);

// --- what a condition proves ------------------------------------------------
//
// Everything below is downstream of one fact, so it is pinned first: a
// `sig`-bound parameter arrives at the `if` as a ground union, not as a variable
// with the union among its bounds. If that ever stops being true, narrowing has
// nothing to intersect and every assertion here goes quiet rather than failing.
//
// The proofs are recorded by shadowing the name in a child scope, which is the
// mechanism a `case` arm already uses. No bound is pushed and no `constrain`
// call is made, so the *whole function type* is the thing to assert: an
// implementation that narrowed by adding an upper bound would leak
// `(Int & 1) -> ...` into the signature and break nothing else.

check(
  "a signature binds a parameter to the ground union itself",
  `sig f = 1 | 2 | 3 -> 1 | 2 | 3
let f = fn n => n
export f
`,
  "1 | 2 | 3 -> 1 | 2 | 3",
);

rejects(
  "an unnarrowed parameter is the whole union",
  `sig h = 1 -> Str
let h = fn k => "one"
sig f = 1 | 2 | 3 -> Str
let f = fn n => h n
export f
`,
  "`2` is outside `1`",
);

check(
  "the branch a condition proves accepts the narrowed value",
  `sig h = 1 -> Str
let h = fn k => "one"
sig f = 1 | 2 | 3 -> Str
let f = fn n => case n == 1 of
  #True => h n
  #False => "rest"
export f
`,
  "1 | 2 | 3 -> Str",
);

// Read together with the previous two: the proven branch is exactly `1`, no
// wider and no narrower.
rejects(
  "the proven branch holds nothing but the narrowed value",
  `sig h = 2 -> Str
let h = fn k => "two"
sig f = 1 | 2 | 3 -> Str
let f = fn n => case n == 1 of
  #True => h n
  #False => "rest"
export f
`,
  "`1` is outside `2`",
);

rejects(
  "the other branch does not accept it",
  `sig h = 1 -> Str
let h = fn k => "one"
sig f = 1 | 2 | 3 -> Str
let f = fn n => case n == 1 of
  #True => "one"
  #False => h n
export f
`,
  "`2` is outside `1`",
);

check(
  "the other branch accepts what the condition excluded",
  `sig k = 2 | 3 -> Str
let k = fn v => "rest"
sig f = 1 | 2 | 3 -> Str
let f = fn n => case n == 1 of
  #True => "one"
  #False => k n
export f
`,
  "1 | 2 | 3 -> Str",
);

check(
  "a proof survives into a case, which is then complete",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n => case n == 1 of
  #True => case n of
      1 => "one"
  #False => case n of
      2 => "two"
      3 => "three"
export f
`,
  "1 | 2 | 3 -> Str",
);

rejects(
  "a proof does not excuse an arm the narrowed set still needs",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n => case n == 1 of
  #True => case n of
      1 => "one"
  #False => case n of
      2 => "two"
export f
`,
  "No arm covers `3`",
);

check(
  "an else-if chain leaves the fallback with what is left",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n => case n == 1 of
  #True => "one"
  #False => case n == 2 of
    #True => "two"
    #False => case n of
        3 => "three"
export f
`,
  "1 | 2 | 3 -> Str",
);

// `@int.cmp` answers on every pair of integers, so the proof does not depend on
// the domain being enumerable. This is the capability no enumeration can have.

check(
  "a comparison narrows an unbounded domain",
  `sig low = range (@type.unbounded, 9) -> Str
let low = fn n => "low"
sig f = Int -> Str
let f = fn n => case n < 10 of
  #True => low n
  #False => "high"
export f
`,
  "Int -> Str",
);

check(
  "the other half of an unbounded domain is the complement",
  `sig high = range (10, @type.unbounded) -> Str
let high = fn n => "high"
sig f = Int -> Str
let f = fn n => case n < 10 of
  #True => "low"
  #False => high n
export f
`,
  "Int -> Str",
);

check(
  "a subject on the right mirrors the comparison",
  `sig high = range (1, @type.unbounded) -> Str
let high = fn n => "high"
sig f = Int -> Str
let f = fn n => case 0 < n of
  #True => high n
  #False => "low"
export f
`,
  "Int -> Str",
);

check(
  "adjacent orderings narrow to one range",
  `sig low = range (@type.unbounded, 9) -> Str
let low = fn n => "low"
sig f = Int -> Str
let f = fn n => case n <= 9 of
  #True => low n
  #False => "high"
export f
`,
  "Int -> Str",
);

check(
  "a disequality narrows the branch where it fails",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n => case n != 1 of
  #True => case n of
      2 => "two"
      3 => "three"
  #False => "one"
export f
`,
  "1 | 2 | 3 -> Str",
);

// A statement `if` lowers to the same node, so it proves the same thing. There
// is no second rule to keep in step.

check(
  "a statement conditional proves it too",
  `sig h = 1 -> Str
let h = fn k => "one"
sig f = 1 | 2 | 3 -> Str
let f = fn n =>
  if n == 1:
    return h n
  return "rest"
export f
`,
  "1 | 2 | 3 -> Str",
);

// Nesting is linear, not exponential: a region has at most two pieces, so `d`
// conditions leave at most `d + 1`, and adjacent cuts collapse. Three exclusions
// from `Int` leave two pieces, and the same call outside the nest is refused.

check(
  "nested exclusions accumulate into a bounded number of pieces",
  `sig only = range (@type.unbounded, 0) | range (4, @type.unbounded) -> Str
let only = fn k => "k"
sig f = Int -> Str
let f = fn n => case n != 1 of
  #True => case n != 2 of
      #True => case n != 3 of
          #True => only n
          #False => "c"
      #False => "b"
  #False => "a"
export f
`,
  "Int -> Str",
);

rejects(
  "the same call outside the nest is not proved",
  `sig only = range (@type.unbounded, 0) | range (4, @type.unbounded) -> Str
let only = fn k => "k"
sig f = Int -> Str
let f = fn n => only n
export f
`,
  "`Int` is not one of `..0` | `4..`",
);

// The proof is a name shadow, so it must not reach the function's own type.

check(
  "a narrowing never widens the signature it was proved under",
  `let f = fn n => case n == 1 of
  #True => "y"
  #False => "n"
export f
`,
  'Int -> ("y" | "n")',
);

check(
  "two conditions on one name do not accumulate an intersection",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n =>
  let a = case n == 1 of
    #True => "x"
    #False => "y"
  let b = case n == 2 of
    #True => "x"
    #False => "y"
  return Text.append a b
export f
`,
  "1 | 2 | 3 -> Str",
);

// A rebinding preserves the *stable* type, so it widens the singleton the branch
// proved. A proof does not survive a `:=` of the name it is about.

check(
  "a rebinding inside a proven branch widens back to the domain",
  `sig f = 1 | 2 | 3 -> Int
let f = fn n => case n == 1 of
  #True => do:
    let n = n
    n := 5
    return n
  #False => 0
export f
`,
  "1 | 2 | 3 -> Int",
);

// --- what a condition refuses to prove --------------------------------------
//
// Each of these would be a false fact, and each is refused by a different clause.
// The assertions are types rather than errors: a refusal leaves the program
// exactly as it was, which is the shape a "narrow nothing" answer has to have.

rejects(
  "a runtime shadow of the operator proves nothing",
  `let Eq = { .eq = fn a => fn b => True; .ne = fn a => fn b => False; }
sig f = 1 | 2 | 3 -> Str
let f = fn n => case n == 1 of
  #True => case n of
      1 => "one"
  #False => "rest"
export f
`,
  "No arm covers `2 | 3`",
);

rejects(
  "an operator supplied by the caller proves nothing",
  `sig g = { .eq = 1 | 2 | 3 -> 1 -> #True | #False; } -> (1 | 2 | 3 -> Str)
let g = fn Eq => fn n => case n == 1 of
  #True => case n of
      1 => "one"
  #False => "rest"
export g
`,
  "No arm covers `2 | 3`",
);

rejects(
  "a witness that is another runtime name proves nothing",
  `sig f = 1 | 2 | 3 -> (1 | 2 -> Str)
let f = fn n => fn m => case n == m of
  #True => "same"
  #False => case n of
      3 => "three"
export f
`,
  "No arm covers `1 | 2`",
);

rejects(
  "a witness bound by `let` is not a compile-time integer",
  `let k = 1
sig f = 1 | 2 | 3 -> Str
let f = fn n => case n == k of
  #True => case n of
      1 => "one"
  #False => "rest"
export f
`,
  "No arm covers `2 | 3`",
);

check(
  "a witness bound by `const` is",
  `const k = 1
sig f = 1 | 2 | 3 -> Str
let f = fn n => case n == k of
  #True => case n of
      1 => "one"
  #False => case n of
      2 => "two"
      3 => "three"
export f
`,
  "1 | 2 | 3 -> Str",
);

// Recognition reads the value, not the spelling, so an operator reached by its
// own name proves exactly what `==` does — and one whose body is not a
// comparison proves nothing, however it is named.

check(
  "the operator's own name proves the same thing",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n => case Eq.eq n 1 of
  #True => case n of
      1 => "one"
  #False => case n of
      2 => "two"
      3 => "three"
export f
`,
  "1 | 2 | 3 -> Str",
);

rejects(
  "an operator carried through a binding proves nothing",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n =>
  let same = Eq.eq
  return case same n 1 of
    #True => case n of
          1 => "one"
    #False => "rest"
export f
`,
  "No arm covers `2 | 3`",
);

check(
  "a condition that proves nothing leaves the branch types alone",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n => case Ord.min n 1 == 1 of
  #True => "y"
  #False => "n"
export f
`,
  "1 | 2 | 3 -> Str",
);

// An unreachable branch is not yet a diagnostic, and narrowing to `⊥` would make
// every use inside it check against nothing. The branch keeps the wider type.

check(
  "a condition no value satisfies narrows nothing",
  `sig f = 1 | 2 | 3 -> Str
let f = fn n => case n == 7 of
  #True => "never"
  #False => case n of
      1 => "a"
      2 => "b"
      3 => "c"
export f
`,
  "1 | 2 | 3 -> Str",
);

// --- a read the source already decides --------------------------------------
//
// An array's type carries no length, so nothing here is proved from a type. The
// length comes from the array literal a binding was written with, and the index
// comes from the same compile-time-integer witness a condition needs. Direct
// access is accepted only when those facts prove the whole index set safe.

check(
  "an index inside the array is still an ordinary read",
  `let xs = [1, 2, 3]
export @array.get xs 2
`,
  "(1 | 2 | 3)",
);

rejects(
  "an index outside an array written at the call site is refused",
  `export @array.get [1, 2, 3] 99
`,
  "Index 99 is outside an array of 3",
);

rejects(
  "an index outside the literal a `let` was given is refused",
  `let xs = [1, 2, 3]
export @array.get xs 99
`,
  "Index 99 is outside an array of 3",
);

rejects(
  "an index outside a compile-time array is refused",
  `const xs = [1, 2, 3]
export @array.get xs 99
`,
  "Index 99 is outside an array of 3",
);

rejects(
  "`@array.set` is decided by the same rule",
  `let xs = [1, 2, 3]
export @array.set xs 99 0
`,
  "Index 99 is outside an array of 3",
);

rejects(
  "a rebinding is measured by the array it rebound to",
  `let xs = [1, 2, 3]
xs := [4, 5, 6, 7]
export @array.get xs 5
`,
  "Index 5 is outside an array of 4",
);

// A parameter is the case that would make this unsound. `xs` inside the lambda
// is whatever the caller passed, and the enclosing `xs` says nothing about it —
// so the length is paired with the `Typing` its binding installed, and a fresh
// `Typing` for the parameter makes the outer record stop matching.

rejects(
  "a parameter shadowing an array binding needs its own proof",
  `let xs = [1, 2, 3]
let read = fn xs => @array.get xs 99
export read
`,
  "BLOT_UNPROVEN_INDEX",
);

rejects(
  "an alias retains a literal array's known length",
  `let xs = [1, 2, 3]
let ys = xs
export @array.get ys 99
`,
  "Index 99 is outside an array of 3",
);

rejects(
  "an unproved access into an array with a spread is refused",
  `let base = [1, 2, 3]
let xs = [0, ...base]
export @array.get xs 99
`,
  "BLOT_UNPROVEN_INDEX",
);

rejects(
  "a direct array read cannot be partially applied around its proof site",
  `let read = fn xs => @array.get xs
export read
`,
  "BLOT_ARRAY_ACCESS_NOT_DIRECT",
);

rejects(
  "a direct array write cannot be aliased away from its proof site",
  `let write = @array.set
export write
`,
  "BLOT_ARRAY_ACCESS_NOT_DIRECT",
);

// The index is decided by a compile-time integer or by a ground type — a `sig`
// gave the name one, or a branch proved one. A `let` generalizes, so a
// `let`-bound integer has a scheme rather than a ground type and decides
// nothing, and anything computed is refused because inferring it here would
// infer it twice.

rejects(
  "an index bound by `let` is rejected when its ground type is outside",
  `let n = 99
let xs = [1, 2, 3]
export @array.get xs n
`,
  "BLOT_OUT_OF_BOUNDS",
);

// --- an index proved against the array's length -----------------------------
//
// `@array.len xs` is a run-time value, but a comparison against it still adds a
// proposition to `Phi`, keyed to the immutable array value. The index and read
// therefore name the same integer without putting that relation in their types.

const GUARDED = `sig at = [Int] -> Int -> Int
let at = fn xs => fn n => case n >= 0 of
  #True => case n < @array.len xs of
    #True => @array.get xs n
    #False => 0
  #False => 0
`;

check(
  "a guarded read is an ordinary read, and its signature is untouched",
  `${GUARDED}export { .fn = at; .call = at [1, 2, 3] 0; }
`,
  "{ .fn = [Int] -> Int -> Int; .call = Int; }",
);

// Relational proofs do not turn into public range types. Calling `small` still
// sees the ordinary nonnegative branch type rather than an array relationship.
rejects(
  "two comparisons prove the index is an index of that array",
  `sig small = 1 | 2 -> Str
let small = fn k => case k of
  1 => "one"
  2 => "two"
sig at = [Int] -> Int -> Str
let at = fn xs => fn n => case n >= 0 of
  #True => case n < @array.len xs of
      #True => small n
      #False => "hi"
  #False => "lo"
export at
`,
  "`0..9223372036854775807` is not one of `1` | `2`",
);

check(
  "a relationally proved index does not escape into a published type",
  `sig n = Int
let n = 5
let g = fn xs => case n < @array.len xs of
  #True => n
  #False => 0
export g
`,
  "['a] -> (Int | 0)",
);

// A junction is recognised by its truth table, so the prelude's `&&` narrows —
// and an index range is still not `1 | 2`.
check(
  "`&&` proves both halves, so a bounded range is covered",
  `sig f = Int -> Str
let f = fn i => case i > 0 && i < 3 of
  #True => case i of
      1 => "a"
      2 => "b"
  #False => "out"
export f
`,
  "Int -> Str",
);

rejects(
  "a junction that is not conjunction proves nothing",
  `const Logic = { .not = fn v => v; .and = fn a => fn b => True; .or = fn a => fn b => a; }
sig f = Int -> Str
let f = fn i => case i > 0 && i < 3 of
  #True => case i of
      1 => "a"
      2 => "b"
  #False => "out"
export f
`,
  "BLOT_INCOMPLETE_CASE",
);

rejects(
  "`&&` narrows the index, and an index range is still not `1 | 2`",
  `sig small = 1 | 2 -> Str
let small = fn k => case k of
  1 => "one"
  2 => "two"
sig at = [Int] -> Int -> Str
let at = fn xs => fn n => case n >= 0 && n < @array.len xs of
  #True => small n
  #False => "lo"
export at
`,
  "is not one of `1` | `2`",
);

// The rejections. Every value the index can take is past the end, whatever the
// array holds — so the read cannot succeed on any input.

rejects(
  "an index at or past the length is refused",
  `sig at = [Int] -> Int -> Int
let at = fn xs => fn n => case n >= @array.len xs of
  #True => @array.get xs n
  #False => 0
export at
`,
  "BLOT_OUT_OF_BOUNDS",
);

rejects(
  "an index equal to the length is refused",
  `sig at = [Int] -> Int -> Int
let at = fn xs => fn n => case n == @array.len xs of
  #True => @array.get xs n
  #False => 0
export at
`,
  "BLOT_OUT_OF_BOUNDS",
);

rejects(
  "`@array.set` is decided against a length by the same rule",
  `sig put = [Int] -> Int -> [Int]
let put = fn xs => fn n => case n >= @array.len xs of
  #True => @array.set xs n 0
  #False => xs
export put
`,
  "BLOT_OUT_OF_BOUNDS",
);

// Each refusal is a length the comparison and the read do not agree about.
// Direct access fails closed rather than leaving an unproved runtime trap.

rejects(
  "a length proved about one array cannot access another",
  `sig at = [Int] -> [Int] -> Int -> Int
let at = fn xs => fn ys => fn n => case n >= @array.len xs of
  #True => @array.get ys n
  #False => 0
export at
`,
  "BLOT_UNPROVEN_INDEX",
);

rejects(
  "an alias preserves the array identity used by a proof",
  `sig at = [Int] -> Int -> Int
let at = fn xs => fn n =>
  let ys = xs
  return case n >= @array.len xs of
    #True => @array.get ys n
    #False => 0
export at
`,
  "BLOT_OUT_OF_BOUNDS",
);

rejects(
  "a rebinding invalidates a proof about the previous value",
  `sig at = [Int] -> [Int] -> Int -> Int
let at = fn xs => fn ws => fn n => case n >= @array.len xs of
  #True => do:
    let xs = xs
    xs := ws
    return @array.get xs n
  #False => 0
export at
`,
  "BLOT_UNPROVEN_INDEX",
);

rejects(
  "an inferred integer is checked once a comparison grounds it",
  `let at = fn xs => fn n => case n >= @array.len xs of
  #True => @array.get xs n
  #False => 0
export at
`,
  "BLOT_OUT_OF_BOUNDS",
);

check(
  "an immutable field path preserves the array identity used by a proof",
  `sig at = { .values = [Int]; } -> Int -> Int
let at = fn box => fn n => case n >= 0 && n < @array.len box.values of
  #True => @array.get box.values n
  #False => 0
export at
`,
  "{ .values = [Int]; } -> Int -> Int",
);

rejects(
  "a field proof cannot access a different array field",
  `sig at = { .left = [Int]; .right = [Int]; } -> Int -> Int
let at = fn box => fn n => case n >= 0 && n < @array.len box.left of
  #True => @array.get box.right n
  #False => 0
export at
`,
  "BLOT_UNPROVEN_INDEX",
);

check(
  "a bound length keeps its relationship to the measured array",
  `sig at = [Int] -> Int -> Int
let at = fn xs => fn n =>
  let length = @array.len xs
  return case n >= 0 && n < length of
    #True => @array.get xs n
    #False => 0
export at
`,
  "[Int] -> Int -> Int",
);

check(
  "affine arithmetic preserves a bound length relationship",
  `sig at = [Int] -> Int -> Int
let at = fn xs => fn n =>
  let last = @int.sub (@array.len xs) 1
  return case n >= 0 && n <= last of
    #True => @array.get xs n
    #False => 0
export at
`,
  "[Int] -> Int -> Int",
);

check(
  "a proof follows an immutable array alias",
  `sig at = [Int] -> Int -> Int
let at = fn xs => fn n =>
  let ys = xs
  return case n >= 0 && n < @array.len xs of
    #True => @array.get ys n
    #False => 0
export at
`,
  "[Int] -> Int -> Int",
);

check(
  "total array access returns an option for an unproved index",
  `sig at = [Int] -> Int -> Option Int
let at = fn xs => fn n => Array.get (xs, n)
export at
`,
  "[Int] -> Int -> #None | #Some Int",
);

check(
  "total array replacement returns an option for an unproved index",
  `sig put = [Int] -> Int -> Int -> Option [Int]
let put = fn xs => fn n => fn value => Array.set (xs, n, value)
export put
`,
  "[Int] -> Int -> Int -> #None | #Some [Int]",
);

check(
  "indexed iteration installs its erased bounds package in the loop body",
  `sig sum = [Int] -> Int
let sum = fn values =>
  let total = 0
  for (index, _) in Iter.indexed values:
    total := total + @array.get values index
  return total
export sum
`,
  "[Int] -> Int",
);

rejects(
  "an ordinary iterator record cannot forge an index package",
  `sig sum = [Int] -> Int
let sum = fn values =>
  let iterator = {
    .state = 0;
    .step = fn index => case index < @array.len values of
      #True => #Some ((index, @array.get values index), index + 1)
      #False => #None
    ;
  }
  let total = 0
  for (index, _) in iterator:
    total := total + @array.get values index
  return total
export sum
`,
  "BLOT_UNPROVEN_INDEX",
);

// --- effects are a lattice element, not a separate pass ---------------------

check(
  "a pure function has no row",
  `let f = fn n => @int.add n 1
export f
`,
  "Int -> Int",
);

check(
  "performing an operation puts it in the row",
  `const Console = @effect { .write = Str -> Unit; }
let greet = fn name =>
  result <- Console.write name
  return result
export { .greet = greet; }
`,
  "{ .greet = Str -> () ~ { Console }; }",
);

check(
  "conditional rebinding stays local to its effect-bound scope",
  `const Counter = @effect { .read = Unit -> Int; }
let adjust = fn () =>
  let result = 0
  if True:
    current <- Counter.read ()
    if current > 0:
      current := current - 1
    result := current
  return result
export { .adjust = adjust; }
`,
  "{ .adjust = () -> (Int | 0) ~ { Counter }; }",
);

check(
  "a compile-time SIMD lane selector produces an immediate-certified access",
  `const lane = 2
let pick = fn vector => Int32x4.lane vector lane
export pick
`,
  "I32x4 -> Int",
);

rejects(
  "a runtime SIMD lane selector is not a target immediate",
  `let pick = fn vector => fn lane => Int32x4.lane vector lane
export pick
`,
  "BLOT_SIMD_IMMEDIATE_NOT_COMPTIME",
);

rejects(
  "checked SIMD construction rejects an out-of-width lane",
  `export Int8x16.splat 128
`,
  "BLOT_TYPE_ERROR",
);

check(
  "wrapping SIMD construction names truncation explicitly",
  `export Int8x16.splat_wrapping 128
`,
  "I8x16",
);

check(
  "effect binding executes a nullary effect value",
  `const Clock = @effect { .now = Unit -> Int; }
let operation = fn () =>
  read <- Clock.now
  return read
export { .operation = operation; }
`,
  "{ .operation = () -> Int ~ { Clock }; }",
);

check(
  "two effects join into one row",
  `const Console = @effect { .write = Str -> Unit; }
const Clock = @effect { .now = Unit -> Int; }
let stamped = fn name =>
  t <- Clock.now ()
  _ <- Console.write name
  return t
export { .stamped = stamped; }
`,
  "{ .stamped = Str -> Int ~ { Clock, Console }; }",
);

check(
  "a compile-time function exposes its inferred effects through type reflection",
  `const Access = (@effect { .read = Unit -> Int; }) <+ { .ecs = 7; }
const system = fn () =>
  value <- Access.read ()
  return value
const metadata = case @type.reflect (@type.of system) of
  #Arrow arrow => sum (map (arrow.effects, (fn effect => (@type.members effect).ecs)))
  _ => -1
export metadata
`,
  "7",
);

// A wrapper adds its own effect to whatever its callback performs, and the row
// variable is what carries "whatever". Nothing here is annotated.
check(
  "a row variable makes an effect-polymorphic wrapper",
  `const Console = @effect { .write = Str -> Unit; }
let logged = fn f => fn x =>
  _ <- Console.write "call"
  result <- f x
  return result
export { .logged = logged; }
`,
  "{ .logged = ('a -> 'b ~ { e }) -> 'a -> 'b ~ { Console, e }; }",
);

Deno.test("a signature can reuse an effect row tail", async () => {
  const type = await typeOf(`const Console = @effect { .write = Str -> Unit; }
sig logged = (Int -> Int ~ { ..e }) -> Int -> Int ~ { Console, ..e }
let logged = fn f => fn x =>
  <- Console.write "call"
  result <- f x
  return result
export logged
`);
  assertStringIncludes(type, "Console");
});

rejects(
  "an effect row tail must relate two positions",
  `sig quiet = Int -> Int ~ { ..e }
let quiet = fn value => value
export quiet
`,
  "BLOT_EFFECT_ROW_TAIL_UNCONSTRAINED",
);

check(
  "an effect nothing performs stays out of the row",
  `const Console = @effect { .write = Str -> Unit; }
let quiet = fn n => @int.add n 1
export { .quiet = quiet; }
`,
  "{ .quiet = Int -> Int; }",
);

// A row is written the way it is printed. It is exact in one direction only:
// the body may perform fewer effects than the signature names, because fewer
// effects is a subtype — but never more, and a bare `->` is the empty row
// rather than silence about effects.

check(
  "a written row is what the printer prints",
  `const Console = @effect { .write = Str -> Unit; }
sig greet = Str -> Unit ~ { Console }
let greet = fn name =>
  result <- Console.write name
  return result
export { .greet = greet; }
`,
  "{ .greet = Str -> () ~ { Console }; }",
);

check(
  "a signature may name an effect the body never performs",
  `const Console = @effect { .write = Str -> Unit; }
sig quiet = Int -> Int ~ { Console }
let quiet = fn n => @int.add n 1
export { .quiet = quiet; }
`,
  "{ .quiet = Int -> Int ~ { Console }; }",
);

rejects(
  "a bare arrow is the empty row, not an unwritten one",
  `const Console = @effect { .write = Str -> Unit; }
sig greet = Str -> Unit
let greet = fn name =>
  result <- Console.write name
  return result
export { .greet = greet; }
`,
  "is not handled",
);

// The row lands on the arrow that runs once every argument has arrived, which
// is where the printer puts it. A second `~` fills the next arrow out, so a
// printed type reads back as itself.
check(
  "a curried signature carries its row on the last arrow",
  `const Console = @effect { .write = Str -> Unit; }
sig join = Str -> Str -> Unit ~ { Console }
let join = fn a => fn b =>
  result <- Console.write (a <> b)
  return result
export { .join = join; }
`,
  "{ .join = Str -> Str -> () ~ { Console }; }",
);

// A row lists effects, and an effect is an ordinary compile-time value — so a
// row naming something else is refused where every other `sig` mistake is.
rejects(
  "a row lists effects and nothing else",
  `sig f = Int -> Int ~ { Int }
let f = fn n => n
export f
`,
  "BLOT_SIG_NOT_COMPTIME",
);

rejects(
  "an unhandled effect at the module boundary is rejected",
  `const Console = @effect { .write = Str -> Unit; }
_ <- Console.write "nobody is listening"
export ()
`,
  "Nothing handles { Console }",
);

// --- `sig` is checked by subsumption ----------------------------------------

check(
  "a signature narrows what inference would have produced",
  `sig increment = Int -> Int
let increment = fn value => value + 1
export increment
`,
  "Int -> Int",
);

rejects(
  "a signature that disagrees with the body is rejected",
  `sig double = Int -> Int
let double = fn v => @text.concat v "!"
export double
`,
  "`Int` is not `Str`",
);

// --- types are values -------------------------------------------------------

check(
  "a `const` whose value is a type is that type",
  `const Bit = 0 | 1
sig b = Bit
let b = 1
export b
`,
  "0 | 1",
);

check(
  "a range accepts what it contains",
  `sig small = range (0, 9)
let small = 7
export small
`,
  "0..9",
);

check(
  "a parameterized unsigned range includes its largest value",
  `sig small = U 2
let small = 3
export small
`,
  "0..3",
);

rejects(
  "a full unsigned storage width is not a runtime integer type",
  `sig word = U64
let word = 0
export word
`,
  "BLOT_UNREPRESENTABLE_INTEGER",
);

rejects(
  "a runtime literal must fit signed i64",
  "export 9223372036854775808\n",
  "BLOT_RUNTIME_INTEGER_RANGE",
);

rejects(
  "a parameterized signed range excludes its positive boundary",
  `sig small = I 2
let small = 2
export small
`,
  "`2` is outside `-2..1`",
);

rejects(
  "a range rejects what it does not contain",
  `sig small = range (0, 9)
let small = 42
export small
`,
  "is outside",
);

// A range names itself. "outside an integer" was true of every range at once,
// which is the one thing the reader already knew.
rejects(
  "a range names the bound the value fell outside of",
  `sig n = Nat
let n = -1
export n
`,
  "`-1` is outside `0..9223372036854775807`",
);

// A span reaches the reader. The checker has always had one; until the
// diagnostic carried the file it indexes into, nothing could render it.
Deno.test("a type error renders with a file, line, and column", async () => {
  const path = `${scratch}/located_${crypto.randomUUID()}.blot`;
  await Deno.writeTextFile(
    path,
    PRELUDE +
      `sig greet = Str -> Str
let greet = fn name => name
export greet 1
`,
  );
  try {
    await checkFile(path);
  } catch (error) {
    if (!(error instanceof BlotError)) throw error;
    if (error.origin === null) {
      throw new Error("the diagnostic named no file to render against");
    }
    assertEquals(
      render(error.origin.path, error.origin.source, error.diagnostic),
      `${path}:4:8: BLOT_TYPE_ERROR: \`1\` is not \`Str\`.`,
    );
    return;
  }
  throw new Error("expected this program to be rejected");
});

// --- staging is a guarantee, not an optimization ---------------------------

rejects(
  "a const cannot silently become a runtime binding",
  `let runtime = 41
const copied = runtime + 1
export copied
`,
  "BLOT_NOT_COMPTIME",
);

rejects(
  "a compdo expression cannot depend on a runtime binding",
  `let runtime = 41
export compdo:
  return runtime + 1
`,
  "BLOT_NOT_COMPTIME",
);

rejects(
  "a signature cannot float past another declaration",
  `sig answer = Int
let unrelated = 0
let answer = 42
export answer
`,
  "must be immediately followed",
);

rejects(
  "a signature cannot be left without a binding",
  `sig answer = Int
export 42
`,
  "has no adjacent binding",
);

rejects(
  "satisfies is a static constraint when its type is known",
  `const Digit = range (0, 9)
export @satisfies 42 Digit
`,
  "is outside",
);

check(
  "a handler result is the common clause result",
  `const Ask = @effect { .ask = Int -> Str; }
let work = fn () =>
  result <- Ask.ask 1
  return result
let text = {
  .ask = fn (_, ?resume) =>
    resumed <- resume "ok"
    return @text.concat resumed "!"
  ;
  .return = fn value => @text.concat value ".";
}
export @handle (Ask, work, text)
`,
  "Str",
);

rejects(
  "resume accepts the operation result type",
  `const Ask = @effect { .ask = Int -> Str; }
let work = fn () =>
  result <- Ask.ask 1
  return result
let wrong = {
  .ask = fn (argument, ?resume) =>
    result <- resume argument
    return result
  ;
  .return = fn value => value;
}
export @handle (Ask, work, wrong)
`,
  "`Int` is not `Str`",
);

// --- explicit predicative Rank-N -------------------------------------------

check(
  "an explicit forall preserves a polymorphic binding",
  `sig identity = @forall (fn T => T -> T)
let identity = fn value => value
export identity
`,
  "forall 'q0. 'q0 -> 'q0",
);

check(
  "a Rank-N parameter may be instantiated at two monotypes",
  `sig use = (@forall (fn T => T -> T)) -> { .number = Int; .text = Str; }
let use = fn identity => {
  .number = identity 42;
  .text = identity "forty-two";
  }
let identity = fn value => value
export use identity
`,
  "{ .number = Int; .text = Str; }",
);

rejects(
  "a monomorphic function does not satisfy a Rank-N parameter",
  `sig use = (@forall (fn T => T -> T)) -> { .number = Int; .text = Str; }
let use = fn identity => {
  .number = identity 42;
  .text = identity "forty-two";
  }
let increment = fn value => @int.add value 1
export use increment
`,
  "rigid type",
);

// --- members of a type value ------------------------------------------------
//
// A member is a closure in a side table. There is no arrow to read off it and
// no scope to infer one in, so a call to one is typed by running it while
// checking: the value it produces is the type. What that leaves behind when the
// call cannot be run is `⊤` — the answer a type variable cannot be, because a
// variable is the join of nothing and therefore satisfies every `sig`.

check(
  "a member call the checker can run is typed by its value",
  `const T = { .x = Int; } <+ { .make = fn n => #Some { .x = n; }; }
let found = T.make 7
export case found of
  #Some p => p.x
  #None => 0
`,
  "(0 | 7)",
);

check(
  "a call to a struct accessor is typed by the storage it reads",
  `const Point = struct { .x = I32; .y = I32; }
let somewhere = Point.new { .y = 20; .x = 10; }
export Point.x somewhere
`,
  "10",
);

check(
  "a member call the checker cannot run knows nothing",
  `const Money = #Money I32 <+ { .of = fn n => #Money n; }
export fn amount => Money.of amount
`,
  "'a -> ⊤",
);

rejects(
  "a sig is not believed for a member call the checker cannot run",
  `const Money = #Money I32 <+ { .of = fn n => #Money n; }
const priced = fn amount =>
  sig converted = Money
  let converted = Money.of amount
  return converted
export priced 42
`,
  "anything is not #Money",
);

check(
  "a member that is not a function keeps its own type",
  `const Money = #Money I32 <+ { .zero = #Money 0; }
export Money.zero
`,
  "#Money 0",
);

check(
  "a callable record attached to a namespace keeps its structural type",
  `const World = seal ("World", Unit) <+ {
  .Position = { .increment = fn value => value + 1; };
  }
export fn value => World.Position.increment value
`,
  "Int -> Int",
);

check(
  "a generated namespace record keeps the values captured by its fields",
  `const bind = fn field => seal ("World", Unit) <+ {
  .Position = {
  .read = fn value => @shape.get value field;
  };
  }
const World = bind "x"
export fn value => World.Position.read value
`,
  "{ .x = 'a; } -> 'a",
);

// --- a tuple target is covered by the cross-product of its columns ----------
//
// Arms of a tuple `case` are a pattern matrix: one row per arm, one column per
// element. Each column is covered on its own terms — a constructor set by the
// constructors named in it, a set no arm list can exhaust only by an
// irrefutable pattern — and what the arms owe together is every combination of
// them. Reading one column at a time is what let `(#Some a, #Some b)` alone
// stand for a pair of options and trap at run time.

check(
  "arms that cover the cross-product need no wildcard",
  `sig join = (Option Int, Option Int) -> Int
let join = fn pair => case pair of
  (#Some a, #Some b) => a + b
  (#Some a, #None) => a
  (#None, #Some b) => b
  (#None, #None) => 0
export join (Some 1, None)
`,
  "Int",
);

rejects(
  "a combination no arm reaches is rejected",
  `sig join = (Option Int, Option Int) -> Int
let join = fn pair => case pair of
  (#Some a, #Some b) => a + b
  (#Some a, #None) => a
  (#None, #Some b) => b
export join (None, None)
`,
  "No arm covers `(#None, #None)`",
);

rejects(
  "a column the target declares wider than the arms is rejected",
  `sig join = (Option Int, Option Int) -> Int
let join = fn pair => case pair of
  (#Some a, #Some b) => a + b
export join (None, None)
`,
  "No arm covers `(#None, _)`",
);

// The arms are what close a column no `sig` declared, exactly as they are for a
// single target: naming `#Some` and `#None` makes the column that union, and a
// caller outside it is refused there rather than at the `case`.
rejects(
  "arms close an undeclared column",
  `let join = fn pair => case pair of
  (#Some a, #Some b) => a + b
export join (None, None)
`,
  "`#None` is not one of #Some",
);

rejects(
  "a column with more values than arms can list needs an irrefutable pattern",
  `sig pick = (Int, Option Int) -> Int
let pick = fn pair => case pair of
  (1, #Some a) => a
  (_, #None) => 0
export pick (2, Some 1)
`,
  "No arm covers `(_, #Some)`",
);

check(
  "an irrefutable pattern is what covers such a column",
  `sig pick = (Int, Option Int) -> Int
let pick = fn pair => case pair of
  (1, #Some a) => a
  (_, _) => 0
export pick (2, Some 1)
`,
  "Int",
);

// A float pattern names one float and its type holds every float, so a float
// column is unlistable for the same reason `Int` is.
rejects(
  "a float column is unlistable too",
  `sig pick = (F64, Option Int) -> Int
let pick = fn pair => case pair of
  (1.0, #Some a) => a
  (_, #None) => 0
export pick (1.0, Some 1)
`,
  "No arm covers `(_, #Some)`",
);

check(
  "three columns are covered the same way",
  `sig triple = (Bool, Bool, Bool) -> Int
let triple = fn t => case t of
  (#True, #True, #True) => 1
  (#True, #True, #False) => 2
  (#True, #False, _) => 3
  (#False, _, _) => 4
export triple (True, False, True)
`,
  "Int",
);

rejects(
  "a missing combination of three columns is named in full",
  `sig triple = (Bool, Bool, Bool) -> Int
let triple = fn t => case t of
  (#True, #True, #True) => 1
  (#True, #False, _) => 3
  (#False, _, _) => 4
export triple (True, True, False)
`,
  "No arm covers `(#True, #True, #False)`",
);

check(
  "a nested tuple is a column like any other",
  `sig nested = ((Option Int, Bool), Option Int) -> Int
let nested = fn v => case v of
  ((#Some a, #True), #None) => a
  ((#Some a, #True), #Some c) => a + c
  ((#Some a, #False), _) => a
  ((#None, _), #Some c) => c
  ((#None, _), #None) => 0
export nested ((Some 1, True), None)
`,
  "Int",
);

rejects(
  "a gap inside a nested tuple is named where it is",
  `sig nested = ((Option Int, Bool), Option Int) -> Int
let nested = fn v => case v of
  ((#Some a, #True), #None) => a
  ((#Some a, #False), _) => a
  ((#None, _), #Some c) => c
  ((#None, _), #None) => 0
export nested ((Some 1, True), Some 2)
`,
  "No arm covers `((#Some, #True), #Some)`",
);

// --- a field named by a value ------------------------------------------------
//
// `@shape.get`, `@shape.set` and `@shape.remove` cannot be given a scheme,
// because the field is chosen by a value. The name is still a compile-time
// value, so the call site is where they get their type — and what they used to
// get instead was an unconstrained variable, which is the most permissive claim
// in the lattice rather than the absence of one.

check(
  "a field named by a literal has that field's type",
  `let r = { .a = 7; .b = "x"; }
export @shape.get r "a"
`,
  "7",
);

rejects(
  "a sig is not believed for a field named by a literal",
  `let r = { .a = 7; }
sig z = 0
let z = @shape.get r "a"
export z
`,
  "`7` is outside `0`",
);

rejects(
  "a field the shape does not have is refused rather than trapped",
  `let r = { .a = 7; }
export @shape.get r "c"
`,
  "no field `.c`",
);

check(
  "setting a field named by a literal answers with the whole shape",
  `let r = { .a = 7; }
export @shape.set r "b" "x"
`,
  '{ .a = 7; .b = "x"; }',
);

check(
  "removing a field named by a literal answers with the rest",
  `let r = { .a = 7; .b = 1; }
export @shape.remove r "b"
`,
  "{ .a = 7; }",
);

// The name decides, so a projection whose shape is only known at run time is
// still an ordinary field demand on it.
check(
  "a literal name types a projection off a parameter",
  `export fn shape => @shape.get shape "a"
`,
  "{ .a = 'a; } -> 'a",
);

rejects(
  "a runtime field name cannot invent a structural result type",
  `let get = fn (shape, name) => @shape.get shape name
export get ({ .a = 1; }, "a")
`,
  "BLOT_DYNAMIC_SHAPE_FIELD",
);

rejects(
  "a generic reflection payload cannot prove a signature",
  `sig reflected = Int -> 0
let reflected = fn value => case @type.reflect value of
  #Shape payload => payload
  _ => 0
export reflected
`,
  "BLOT_REFLECTION_NOT_INDEXED",
);

rejects(
  "a generic reflection payload cannot drive a runtime operation",
  `let reflected = fn value => case @type.reflect value of
  #Shape payload => payload
  _ => 0
export @int.add (reflected 1) 1
`,
  "BLOT_REFLECTION_NOT_INDEXED",
);

// --- recursive groups --------------------------------------------------------
//
// A run of adjacent `rec` bindings of one kind is one group, and every name in
// the run is in scope in every member. Nothing else changes: a `let` still
// shadows the binding above it, which is exactly why the run has to be marked
// rather than the whole block being mutually visible.

check(
  "two `rec` bindings in a run see each other",
  `let is_even = rec (fn n => case n == 0 of
  #True => True
  #False => is_odd (n - 1)
)
let is_odd = rec (fn n => case n == 0 of
  #True => False
  #False => is_even (n - 1)
)
export is_even 10
`,
  "(#True | #False)",
);

check(
  "three `rec` bindings in a cycle see each other",
  `let a = rec (fn n => case n == 0 of
  #True => 0
  #False => b (n - 1)
)
let b = rec (fn n => case n == 0 of
  #True => 1
  #False => c (n - 1)
)
let c = rec (fn n => case n == 0 of
  #True => 2
  #False => a (n - 1)
)
export a 7
`,
  "(0 | 1 | 2)",
);

// Membership is adjacency, not participation: a group is what the source marks
// as one, so a member calling nobody is still typed with the rest.
check(
  "a group member that is not recursive at all is still a member",
  `let ping = rec (fn n => case n == 0 of
  #True => 0
  #False => pong (n - 1)
)
let pong = rec (fn n => case n == 0 of
  #True => 1
  #False => ping (n - 1)
)
let plain = rec (fn n => n + 1)
export plain (ping 5)
`,
  "Int",
);

check(
  "a group inside a nested block sees itself",
  `export do:
  let up = rec (fn n => case n == 0 of
    #True => 0
    #False => down (n - 1)
  )
  let down = rec (fn n => case n == 0 of
    #True => 1
    #False => up (n - 1)
  )
  return up 9
`,
  "(0 | 1)",
);

check(
  "a group inside a lambda body sees itself",
  `let outer = fn start =>
  let up = rec (fn n => case n == 0 of
    #True => 0
    #False => down (n - 1)
  )
  let down = rec (fn n => case n == 0 of
    #True => 1
    #False => up (n - 1)
  )
  return up start
export outer 9
`,
  "(0 | 1)",
);

// A `sig` has to be followed by the binding it constrains, so one written
// inside a run is a member's own signature and cannot be separating anything.
check(
  "a member's `sig` does not break the run",
  `sig ping = Int -> Int
let ping = rec (fn n => case n == 0 of
  #True => 0
  #False => pong (n - 1)
)
sig pong = Int -> Int
let pong = rec (fn n => case n == 0 of
  #True => 1
  #False => ping (n - 1)
)
export ping 4
`,
  "Int",
);

check(
  "a `const` run is a group too",
  `const even = rec (fn n => case n == 0 of
  #True => True
  #False => odd (n - 1)
)
const odd = rec (fn n => case n == 0 of
  #True => False
  #False => even (n - 1)
)
export even 12
`,
  "(#True | #False)",
);

// The reason the rule is a marked run rather than the whole block. Under
// block-wide mutual visibility this program would rebind `value` to itself.
check(
  "a repeated `let` still shadows the binding above it",
  `let value = 1
let value = value + 1
let value = value + 1
export value
`,
  "Int",
);

rejects(
  "a declaration between two `rec` bindings ends the run",
  `let a = rec (fn n => b n)
let gap = 1
let b = rec (fn n => n + gap)
export a 1
`,
  "`b` is bound further down",
);

rejects(
  "a value that reads a later binding names the ordering, not a typo",
  `let total = later + 1
let later = 2
export total
`,
  "`later` is bound further down",
);

// The hint has to be earned. A name nothing binds is still just unbound.
rejects(
  "a name no declaration binds is still an ordinary unbound name",
  `let total = nowhere + 1
export total
`,
  "`nowhere` is not in scope",
);

rejects(
  "a group member that is not a function is refused",
  `let total = rec (later 1)
let later = rec (fn n => n + 1)
export total
`,
  "`rec` applies to a lambda",
);

rejects(
  "one name cannot be bound twice in one group",
  `let step = rec (fn n => step n)
let step = rec (fn n => n + 1)
export step 3
`,
  "bound twice in one recursive group",
);

// Two `rec` bindings of different kinds are two groups, not one. A `const` and
// a `let` in one knot would be a compile-time closure capturing a runtime one,
// which is the capture rule's whole subject.
rejects(
  "a `const` and a `let` do not share a group",
  `const up = rec (fn n => case n == 0 of
  #True => 0
  #False => down (n - 1)
)
let down = rec (fn n => case n == 0 of
  #True => 1
  #False => up (n - 1)
)
export up 4
`,
  "`down` is bound further down",
);

// A tag replaces the binding's value with the transform applied to it, so a
// tagged binding holds no `rec` to group and ends the run it sits in.
rejects(
  "a tagged binding is not a group member",
  `@[derive(identity)]
let up = rec (fn n => case n == 0 of
  #True => 0
  #False => down (n - 1)
)
let down = rec (fn n => case n == 0 of
  #True => 1
  #False => up (n - 1)
)
export up 5
`,
  "`down` is bound further down",
);

// The ordering fact outlives the block it was recorded in: a nested block sits
// inside one of the enclosing declarations, so a name it reads too early is
// early for the same reason.
rejects(
  "a nested block reads an enclosing binding too early",
  `let a =
  let t = 1
  return t + later
let later = 2
export a
`,
  "`later` is bound further down",
);
