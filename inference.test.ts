// Principal types, asserted as strings.
//
// This is the point of writing them down: a lattice change that widens an
// inferred type shows up here as a diff rather than as "still compiles". A test
// that only checked "no error" would pass just as happily with a checker that
// inferred `⊤` for everything.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { checkFile } from "./src/check/mod.ts";
import { BlotError, render } from "./src/diagnostic.ts";

const scratch = await Deno.makeTempDir();

// Every snippet opens the prelude, because every module does: it has no
// privilege, and a fixture that skipped it would be testing a language where
// `+` is unbound.
const PRELUDE = 'open {} = (@import "blot:prelude") ();\n';

async function typeOf(source: string): Promise<string> {
  const path = `${scratch}/case_${crypto.randomUUID()}.blot`;
  await Deno.writeTextFile(path, PRELUDE + source);
  const checked = await checkFile(path);
  return checked.type;
}

async function errorOf(source: string): Promise<string> {
  const path = `${scratch}/case_${crypto.randomUUID()}.blot`;
  await Deno.writeTextFile(path, PRELUDE + source);
  try {
    await checkFile(path);
  } catch (error) {
    if (error instanceof BlotError) return error.message;
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

// --- literals are singleton types -------------------------------------------

check(
  "an integer literal is its own type",
  "return 42;",
  "42",
);

check(
  "a float literal is not a singleton",
  "return 1.5;",
  "F64",
);

check(
  "float arithmetic stays in the one float type",
  'open {} = (@import "blot:prelude") ();\nreturn Float.add 1.5 2.5;',
  "F64",
);

check(
  "a float has no equality, only an ordering that refuses NaN",
  'open {} = (@import "blot:prelude") ();\n' +
    "return { .same = is_equal (Float.cmp 0.5 0.5); .nan = Float.is_nan 1.0; };",
  "{ .same = (#True | #False); .nan = #True | #False; }",
);

check(
  "a four-lane vector is an opaque type, not a range",
  'open {} = (@import "blot:prelude") ();\n' +
    "return Vec4.splat (Float32.of_int 1);",
  "F32x4",
);

check(
  "a lane read leaves the vector for the scalar type",
  'open {} = (@import "blot:prelude") ();\n' +
    "return Vec4.x (Vec4.splat (Float32.of_int 1));",
  "F32",
);

rejects(
  "literal arms cannot cover a vector",
  'open {} = (@import "blot:prelude") ();\n' +
    "sig f = F32x4 -> Int;\nlet f = fn v => case v of 1 => 1 end;\n" +
    "return f (Vec4.splat (Float32.of_int 1));",
  "BLOT_INCOMPLETE_CASE",
);

check(
  "single precision is its own type",
  'open {} = (@import "blot:prelude") ();\n' +
    "return Float32.mul (Float32.of_int 2) (Float32.of_float 1.5);",
  "F32",
);

rejects(
  "the two float precisions do not mix",
  'open {} = (@import "blot:prelude") ();\n' +
    "return Float.add 1.5 (Float32.of_int 1);",
  "BLOT_TYPE_ERROR",
);

check(
  "crossing between the numeric types is explicit and exact",
  'open {} = (@import "blot:prelude") ();\n' +
    "return { .up = Float.of_int 7; .down = Float.truncate 3.75; };",
  "{ .up = F64; .down = Int; }",
);

rejects(
  "a float case is never exhaustive on its own",
  'open {} = (@import "blot:prelude") ();\n' +
    "sig pick = F64 -> Int;\nlet pick = fn x => case x of 1.5 => 1 end;\n" +
    "return pick 1.5;",
  "BLOT_INCOMPLETE_CASE",
);

rejects(
  "the two numeric types do not mix",
  'open {} = (@import "blot:prelude") ();\nreturn Float.add 1.5 2;',
  "BLOT_TYPE_ERROR",
);

check(
  "identity preserves the singleton",
  "let identity = fn x => x;\nreturn identity 42;",
  "42",
);

check(
  "arithmetic widens to the domain, because it cannot prove a width",
  "return @int.add 20 22;",
  "Int",
);

// --- functions and let-polymorphism -----------------------------------------

check(
  "identity is polymorphic",
  "let identity = fn x => x;\nreturn identity;",
  "'a -> 'a",
);

check(
  "one binding instantiates independently per use",
  'let identity = fn x => x;\nreturn { .a = identity 1; .b = identity "two"; };',
  '{ .a = 1; .b = "two"; }',
);

check(
  "rebinding preserves the integer domain",
  "let value = 1;\nvalue := 2;\nreturn value;",
  "Int",
);

rejects(
  "rebinding rejects a different type",
  'let value = 1;\nvalue := "two";\nreturn value;',
  "Use `let value = ...;`",
);

check(
  "a repeated let may shadow with a different type",
  'let value = 1;\nlet value = "two";\nreturn value;',
  '"two"',
);

check(
  "rebinding preserves polymorphism",
  'let identity = fn x => x;\nidentity := fn x => x;\nreturn { .number = identity 1; .text = identity "two"; };',
  '{ .number = 1; .text = "two"; }',
);

check(
  "an unconditional early return determines the function result",
  "let answer = fn () => do\n  return 42;\nend;\nreturn answer;",
  "() -> 42",
);

check(
  "a statement conditional returns from its function",
  'let describe = fn value => do\n  if value < 0 then do\n    return "negative";\n  end;\n  in "positive"\nend;\nreturn describe;',
  'Int -> ("negative" | "positive")',
);

check(
  "a return crosses a for loop",
  "let find = fn wanted => do\n  for value in Iter.range (0, 5) do\n    if value == wanted then do\n      return value;\n    end;\n  end;\n  in -1\nend;\nreturn find;",
  "Int -> (Int | 0 | -1)",
);

check(
  "a return crosses an unbounded loop",
  "let count_to = fn limit => do\n  let count = 0;\n  for ever do\n    count := count + 1;\n    if count >= limit then do\n      return count;\n    end;\n  end;\n  in 0\nend;\nreturn count_to;",
  "Int -> (Int | 0)",
);

rejects(
  "rebinding requires an existing name",
  "missing := 1;\nreturn missing;",
  "cannot shadow a name that is not in scope",
);

check(
  "a curried section keeps its remaining parameter",
  "let add = fn a => fn b => @int.add a b;\nreturn add 2;",
  "Int -> Int",
);

// Not `('a -> 'a) -> 'a -> 'a`. Hindley-Milner has to unify the two uses of `f`;
// with subtyping the principal type is their intersection, which is strictly
// more general. Writing the expected string down is what caught the assumption.
check(
  "applying a parameter twice intersects its two uses",
  "let twice = fn f => fn x => f (f x);\nreturn twice;",
  "('a -> 'b ~ { e } & 'b -> 'c ~ { e }) -> 'a -> 'c ~ { e }",
);

// --- records: width subtyping is the whole of a `duck` contract --------------

check(
  "a projection constrains only the field it reaches for",
  "let width = fn shape => shape.w;\nreturn width;",
  "{ .w = 'a; } -> 'a",
);

check(
  "two projections accumulate one record constraint",
  "let area = fn s => @int.mul s.w s.h;\nreturn area;",
  "{ .w = Int; .h = Int; } -> Int",
);

rejects(
  "a missing field is an ordinary constraint failure",
  "let area = fn s => @int.mul s.w s.h;\nreturn area { .w = 2; };",
  "no field `.h`",
);

// --- variants, unions, and narrowing ----------------------------------------

check(
  "a case joins its arms",
  "let f = fn m => case m of #Ready => 1, #Failed r => r end;\nreturn f;",
  "#Ready | #Failed 'a -> ('a | 1)",
);

check(
  "an unmatched branch keeps the parameter open",
  "let f = fn (flag, other) => case flag of #No => #Off, #Yes => other end;\nreturn f;",
  "(#No | #Yes, 'a) -> ('a | #Off)",
);

check(
  "a default arm still types the constructor arms it accompanies",
  "let f = fn m => case m of #Some inner => inner, _ => 0 end;\nreturn f;",
  "#Some 'a | .. -> ('a | 0)",
);

check(
  "an open union accepts a constructor no arm names",
  'let f = fn m => case m of #Some inner => inner, _ => 0 end;\nreturn f (#Some "hi");',
  '(0 | "hi")',
);

check(
  "a name arm is the target",
  "let f = fn m => case m of other => other end;\nreturn f;",
  "'a -> 'a",
);

check(
  "a guard types what it binds",
  'let f = fn m => do\n  if let #Some inner = m else do\n    return "none";\n  end;\n  in inner\nend;\nreturn f (#Some 7);',
  '("none" | 7)',
);

rejects(
  "a guard rejects a payload used at the wrong type",
  'let f = fn m => do\n  if let #Some inner = m else do\n    return "none";\n  end;\n  in Text.append inner "!"\nend;\nreturn f (#Some 3);',
  "`3` is not `Str`",
);

rejects(
  "a constructor no arm covers is rejected",
  'let f = fn m => case m of #Ready => 1, #Busy n => n end;\nreturn f (#Failed "x");',
  "`#Failed` is not one of",
);

rejects(
  "a declared literal union rejects a value outside it",
  "sig level = 1 | 2 | 3;\nlet level = 7;\nreturn level;",
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
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => case n of 1 => "one" end;\nreturn f;',
  "No arm covers `2 | 3`",
);

rejects(
  "a text literal no arm covers is rejected",
  'sig f = "up" | "down" -> Int;\nlet f = fn d => case d of "up" => 1 end;\nreturn f;',
  'No arm covers `"down"`',
);

check(
  "arms that exhaust a literal union are accepted",
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => case n of 1 => "one", 2 => "two", 3 => "three" end;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

check(
  "an irrefutable arm covers the rest of a literal union",
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => case n of 1 => "one", _ => "rest" end;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

check(
  "literal arms still constrain nothing on their own",
  'let f = fn n => case n of 1 => "one", 2 => "two" end;\nreturn f;',
  '\'a -> ("one" | "two")',
);

rejects(
  "an unbounded domain cannot be covered by literal arms",
  'sig f = Int -> Str;\nlet f = fn n => case n of 1 => "one" end;\nreturn f;',
  "BLOT_INCOMPLETE_CASE",
);

check(
  "a `_` arm covers what literals cannot, and `@panic` says why it is unreachable",
  'sig f = Int -> Str;\nlet f = fn n => case n of 1 => "one", _ => @panic "not one" end;\nreturn f;',
  "Int -> Str",
);

check(
  "a literal payload arm leaves its constructor set alone",
  'let f = fn m => case m of #Some 1 => "one", #Some n => "many", #None => "none" end;\nreturn f (#Some 2);',
  '("one" | "many" | "none")',
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
  "sig f = 1 | 2 | 3 -> 1 | 2 | 3;\nlet f = fn n => n;\nreturn f;",
  "1 | 2 | 3 -> 1 | 2 | 3",
);

rejects(
  "an unnarrowed parameter is the whole union",
  'sig h = 1 -> Str;\nlet h = fn k => "one";\nsig f = 1 | 2 | 3 -> Str;\nlet f = fn n => h n;\nreturn f;',
  "`2` is outside `1`",
);

check(
  "the branch a condition proves accepts the narrowed value",
  'sig h = 1 -> Str;\nlet h = fn k => "one";\nsig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n == 1 then h n else "rest" end;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

// Read together with the previous two: the proven branch is exactly `1`, no
// wider and no narrower.
rejects(
  "the proven branch holds nothing but the narrowed value",
  'sig h = 2 -> Str;\nlet h = fn k => "two";\nsig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n == 1 then h n else "rest" end;\nreturn f;',
  "`1` is outside `2`",
);

rejects(
  "the other branch does not accept it",
  'sig h = 1 -> Str;\nlet h = fn k => "one";\nsig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n == 1 then "one" else h n end;\nreturn f;',
  "`2` is outside `1`",
);

check(
  "the other branch accepts what the condition excluded",
  'sig k = 2 | 3 -> Str;\nlet k = fn v => "rest";\nsig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n == 1 then "one" else k n end;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

check(
  "a proof survives into a case, which is then complete",
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n == 1 then case n of 1 => "one" end else case n of 2 => "two", 3 => "three" end end;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

rejects(
  "a proof does not excuse an arm the narrowed set still needs",
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n == 1 then case n of 1 => "one" end else case n of 2 => "two" end end;\nreturn f;',
  "No arm covers `3`",
);

check(
  "an else-if chain leaves the fallback with what is left",
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n == 1 then "one" else if n == 2 then "two" else case n of 3 => "three" end end;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

// `@int.cmp` answers on every pair of integers, so the proof does not depend on
// the domain being enumerable. This is the capability no enumeration can have.

check(
  "a comparison narrows an unbounded domain",
  'sig low = range (@type.unbounded, 9) -> Str;\nlet low = fn n => "low";\nsig f = Int -> Str;\nlet f = fn n => if n < 10 then low n else "high" end;\nreturn f;',
  "Int -> Str",
);

check(
  "the other half of an unbounded domain is the complement",
  'sig high = range (10, @type.unbounded) -> Str;\nlet high = fn n => "high";\nsig f = Int -> Str;\nlet f = fn n => if n < 10 then "low" else high n end;\nreturn f;',
  "Int -> Str",
);

check(
  "a subject on the right mirrors the comparison",
  'sig high = range (1, @type.unbounded) -> Str;\nlet high = fn n => "high";\nsig f = Int -> Str;\nlet f = fn n => if 0 < n then high n else "low" end;\nreturn f;',
  "Int -> Str",
);

check(
  "adjacent orderings narrow to one range",
  'sig low = range (@type.unbounded, 9) -> Str;\nlet low = fn n => "low";\nsig f = Int -> Str;\nlet f = fn n => if n <= 9 then low n else "high" end;\nreturn f;',
  "Int -> Str",
);

check(
  "a disequality narrows the branch where it fails",
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n /= 1 then case n of 2 => "two", 3 => "three" end else "one" end;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

// A statement `if` lowers to the same node, so it proves the same thing. There
// is no second rule to keep in step.

check(
  "a statement conditional proves it too",
  'sig h = 1 -> Str;\nlet h = fn k => "one";\nsig f = 1 | 2 | 3 -> Str;\nlet f = fn n => do\n  if n == 1 then do\n    return h n;\n  end;\n  in "rest"\nend;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

// Nesting is linear, not exponential: a region has at most two pieces, so `d`
// conditions leave at most `d + 1`, and adjacent cuts collapse. Three exclusions
// from `Int` leave two pieces, and the same call outside the nest is refused.

check(
  "nested exclusions accumulate into a bounded number of pieces",
  'sig only = range (@type.unbounded, 0) | range (4, @type.unbounded) -> Str;\nlet only = fn k => "k";\nsig f = Int -> Str;\nlet f = fn n => if n /= 1 then (if n /= 2 then (if n /= 3 then only n else "c" end) else "b" end) else "a" end;\nreturn f;',
  "Int -> Str",
);

rejects(
  "the same call outside the nest is not proved",
  'sig only = range (@type.unbounded, 0) | range (4, @type.unbounded) -> Str;\nlet only = fn k => "k";\nsig f = Int -> Str;\nlet f = fn n => only n;\nreturn f;',
  "`Int` is not one of `..0` | `4..`",
);

// The proof is a name shadow, so it must not reach the function's own type.

check(
  "a narrowing never widens the signature it was proved under",
  'let f = fn n => if n == 1 then "y" else "n" end;\nreturn f;',
  'Int -> ("y" | "n")',
);

check(
  "two conditions on one name do not accumulate an intersection",
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => do\n  let a = if n == 1 then "x" else "y" end;\n  let b = if n == 2 then "x" else "y" end;\n  in Text.append a b\nend;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

// A rebinding preserves the *stable* type, so it widens the singleton the branch
// proved. A proof does not survive a `:=` of the name it is about.

check(
  "a rebinding inside a proven branch widens back to the domain",
  "sig f = 1 | 2 | 3 -> Int;\nlet f = fn n => if n == 1 then do\n  n := 5;\n  in n\nend else 0 end;\nreturn f;",
  "1 | 2 | 3 -> Int",
);

// --- what a condition refuses to prove --------------------------------------
//
// Each of these would be a false fact, and each is refused by a different clause.
// The assertions are types rather than errors: a refusal leaves the program
// exactly as it was, which is the shape a "narrow nothing" answer has to have.

rejects(
  "a runtime shadow of the operator proves nothing",
  'let Eq = { .eq = fn a => fn b => True; .ne = fn a => fn b => False; };\nsig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n == 1 then case n of 1 => "one" end else "rest" end;\nreturn f;',
  "No arm covers `2 | 3`",
);

rejects(
  "an operator supplied by the caller proves nothing",
  'sig g = { .eq = 1 | 2 | 3 -> 1 -> #True | #False; } -> (1 | 2 | 3 -> Str);\nlet g = fn Eq => fn n => if n == 1 then case n of 1 => "one" end else "rest" end;\nreturn g;',
  "No arm covers `2 | 3`",
);

rejects(
  "a witness that is another runtime name proves nothing",
  'sig f = 1 | 2 | 3 -> (1 | 2 -> Str);\nlet f = fn n => fn m => if n == m then "same" else case n of 3 => "three" end end;\nreturn f;',
  "No arm covers `1 | 2`",
);

rejects(
  "a witness bound by `let` is not a compile-time integer",
  'let k = 1;\nsig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n == k then case n of 1 => "one" end else "rest" end;\nreturn f;',
  "No arm covers `2 | 3`",
);

check(
  "a witness bound by `const` is",
  'const k = 1;\nsig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n == k then case n of 1 => "one" end else case n of 2 => "two", 3 => "three" end end;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

// Recognition reads the value, not the spelling, so an operator reached by its
// own name proves exactly what `==` does — and one whose body is not a
// comparison proves nothing, however it is named.

check(
  "the operator's own name proves the same thing",
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if Eq.eq n 1 then case n of 1 => "one" end else case n of 2 => "two", 3 => "three" end end;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

rejects(
  "an operator carried through a binding proves nothing",
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => do\n  let same = Eq.eq;\n  in if same n 1 then case n of 1 => "one" end else "rest" end\nend;\nreturn f;',
  "No arm covers `2 | 3`",
);

check(
  "a condition that proves nothing leaves the branch types alone",
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if Ord.min n 1 == 1 then "y" else "n" end;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

// An unreachable branch is not yet a diagnostic, and narrowing to `⊥` would make
// every use inside it check against nothing. The branch keeps the wider type.

check(
  "a condition no value satisfies narrows nothing",
  'sig f = 1 | 2 | 3 -> Str;\nlet f = fn n => if n == 7 then "never" else case n of 1 => "a", 2 => "b", 3 => "c" end end;\nreturn f;',
  "1 | 2 | 3 -> Str",
);

// --- a read the source already decides --------------------------------------
//
// An array's type carries no length, so nothing here is proved from a type. The
// length comes from the array literal a binding was written with, the index from
// the same compile-time-integer witness a condition needs, and the answer is a
// diagnostic rather than a fact: the call is still typed by the ordinary scheme.
//
// The refusals matter more than the acceptance, and they are asserted as types,
// because refusing to decide has to leave the program exactly as it was.

check(
  "an index inside the array is still an ordinary read",
  "let xs = [1, 2, 3];\nreturn @array.get xs 2;",
  "(1 | 2 | 3)",
);

rejects(
  "an index outside an array written at the call site is refused",
  "return @array.get [1, 2, 3] 99;",
  "Index 99 is outside an array of 3",
);

rejects(
  "an index outside the literal a `let` was given is refused",
  "let xs = [1, 2, 3];\nreturn @array.get xs 99;",
  "Index 99 is outside an array of 3",
);

rejects(
  "an index outside a compile-time array is refused",
  "const xs = [1, 2, 3];\nreturn @array.get xs 99;",
  "Index 99 is outside an array of 3",
);

rejects(
  "`@array.set` is decided by the same rule",
  "let xs = [1, 2, 3];\nreturn @array.set xs 99 0;",
  "Index 99 is outside an array of 3",
);

rejects(
  "a rebinding is measured by the array it rebound to",
  "let xs = [1, 2, 3];\nxs := [4, 5, 6, 7];\nreturn @array.get xs 5;",
  "Index 5 is outside an array of 4",
);

// A parameter is the case that would make this unsound. `xs` inside the lambda
// is whatever the caller passed, and the enclosing `xs` says nothing about it —
// so the length is paired with the `Typing` its binding installed, and a fresh
// `Typing` for the parameter makes the outer record stop matching.

check(
  "a parameter shadowing an array binding is not measured by it",
  "let xs = [1, 2, 3];\nlet read = fn xs => @array.get xs 99;\nreturn read;",
  "['a] -> 'a",
);

check(
  "an aliased array is not measured by the array it aliases",
  "let xs = [1, 2, 3];\nlet ys = xs;\nreturn @array.get ys 99;",
  "(1 | 2 | 3)",
);

check(
  "an array written with a spread has no length here",
  "let base = [1, 2, 3];\nlet xs = [0, ...base];\nreturn @array.get xs 99;",
  "(0 | 1 | 2 | 3)",
);

// The index is decided by a compile-time integer or by a ground type — a `sig`
// gave the name one, or a branch proved one. A `let` generalizes, so a
// `let`-bound integer has a scheme rather than a ground type and decides
// nothing, and anything computed is refused because inferring it here would
// infer it twice.

check(
  "an index bound by `let` decides nothing",
  "let n = 99;\nlet xs = [1, 2, 3];\nreturn @array.get xs n;",
  "(1 | 2 | 3)",
);

// --- an index proved against the array's length -----------------------------
//
// `@array.len xs` is a run-time value, and a comparison against it narrows
// anyway: the bound is the symbol `len xs`, keyed to the binding occurrence, so
// the index and the read name the same integer without anyone knowing which one
// it is. The proof is still only a diagnostic — an index is never constrained,
// so no published type moves and `@array.get` still emits a checked read.

const GUARDED = "sig at = [Int] -> Int -> Int;\n" +
  "let at = fn xs => fn n =>\n" +
  "  if n >= 0\n" +
  "  then (if n < @array.len xs then @array.get xs n else 0 end)\n" +
  "  else 0\n" +
  "  end;\n";

check(
  "a guarded read is an ordinary read, and its signature is untouched",
  `${GUARDED}return { .fn = at; .call = at [1, 2, 3] 0; };`,
  "{ .fn = [Int] -> Int -> Int; .call = Int; }",
);

// The proof itself, as a string. Two nested comparisons leave the index exactly
// the set of indices the array has, and the second one is the half that needs
// `0 <= len xs` to be admitted at all.
rejects(
  "two comparisons prove the index is an index of that array",
  "sig small = 1 | 2 -> Str;\n" +
    'let small = fn k => case k of 1 => "one", 2 => "two" end;\n' +
    "sig at = [Int] -> Int -> Str;\n" +
    "let at = fn xs => fn n =>\n" +
    '  if n >= 0 then (if n < @array.len xs then small n else "hi" end)\n' +
    '  else "lo" end;\n' +
    "return at;",
  "`0..len xs - 1` is not one of `1` | `2`",
);

check(
  "a proved index escaping into a published type is spelled, not hidden",
  "sig n = Int;\nlet n = 5;\n" +
    "let g = fn xs => if n < @array.len xs then n else 0 end;\nreturn g;",
  "['a] -> (..len xs - 1 | 0)",
);

// `&&` proves nothing, so the guard has to nest. This is pinned as the type it
// leaves rather than as a wish: a junction is recognised by its truth table,
// so `&&` narrows — and an index range is still not `1 | 2`.
check(
  "`&&` proves both halves, so a bounded range is covered",
  "sig f = Int -> Str;\n" +
    'let f = fn i => if i > 0 && i < 3 then case i of 1 => "a", 2 => "b" end else "out" end;\n' +
    "return f;",
  "Int -> Str",
);

rejects(
  "a junction that is not conjunction proves nothing",
  "const Logic = { .not = fn v => v; .and = fn a => fn b => True; .or = fn a => fn b => a; };\n" +
    "sig f = Int -> Str;\n" +
    'let f = fn i => if i > 0 && i < 3 then case i of 1 => "a", 2 => "b" end else "out" end;\n' +
    "return f;",
  "BLOT_INCOMPLETE_CASE",
);

rejects(
  "`&&` narrows the index, and an index range is still not `1 | 2`",
  "sig small = 1 | 2 -> Str;\n" +
    'let small = fn k => case k of 1 => "one", 2 => "two" end;\n' +
    "sig at = [Int] -> Int -> Str;\n" +
    "let at = fn xs => fn n =>\n" +
    '  if n >= 0 && n < @array.len xs then small n else "lo" end;\n' +
    "return at;",
  "is not one of `1` | `2`",
);

// The rejections. Every value the index can take is past the end, whatever the
// array holds — so the read cannot succeed on any input.

rejects(
  "an index at or past the length is refused",
  "sig at = [Int] -> Int -> Int;\n" +
    "let at = fn xs => fn n => if n >= @array.len xs then @array.get xs n else 0 end;\n" +
    "return at;",
  "Index len xs.. is outside an array of len xs",
);

rejects(
  "an index equal to the length is refused",
  "sig at = [Int] -> Int -> Int;\n" +
    "let at = fn xs => fn n => if n == @array.len xs then @array.get xs n else 0 end;\n" +
    "return at;",
  "Index len xs is outside an array of len xs",
);

rejects(
  "`@array.set` is decided against a length by the same rule",
  "sig put = [Int] -> Int -> [Int];\n" +
    "let put = fn xs => fn n => if n >= @array.len xs then @array.set xs n 0 else xs end;\n" +
    "return put;",
  "Index len xs.. is outside an array of len xs",
);

// The refusals, asserted as types. Each one is a length the comparison and the
// read do not agree about, and each is silent: a read nobody could decide is
// left to trap exactly as it did.

check(
  "a length proved about one array says nothing about another",
  "sig at = [Int] -> [Int] -> Int -> Int;\n" +
    "let at = fn xs => fn ys => fn n =>\n" +
    "  if n >= @array.len xs then @array.get ys n else 0 end;\n" +
    "return at;",
  "[Int] -> [Int] -> Int -> Int",
);

check(
  "an alias is another occurrence, so a proof does not carry to it",
  "sig at = [Int] -> Int -> Int;\n" +
    "let at = fn xs => fn n => do\n" +
    "  let ys = xs;\n" +
    "  in if n >= @array.len xs then @array.get ys n else 0 end\n" +
    "end;\n" +
    "return at;",
  "[Int] -> Int -> Int",
);

check(
  "a rebinding is a new occurrence, so an old proof decides nothing about it",
  "sig at = [Int] -> [Int] -> Int -> Int;\n" +
    "let at = fn xs => fn ws => fn n =>\n" +
    "  if n >= @array.len xs then do\n" +
    "    xs := ws;\n" +
    "    in @array.get xs n\n" +
    "  end else 0 end;\n" +
    "return at;",
  "[Int] -> [Int] -> Int -> Int",
);

check(
  "an index with no ground type decides nothing",
  "let at = fn xs => fn n => if n >= @array.len xs then @array.get xs n else 0 end;\n" +
    "return at;",
  "(['a] & ['b]) -> Int -> ('b | 0)",
);

check(
  "an array reached by anything but a name has no occurrence to name",
  "sig at = { .values = [Int]; } -> Int -> Int;\n" +
    "let at = fn box => fn n =>\n" +
    "  if n >= @array.len box.values then @array.get box.values n else 0 end;\n" +
    "return at;",
  "{ .values = [Int]; } -> Int -> Int",
);

// --- effects are a lattice element, not a separate pass ---------------------

check(
  "a pure function has no row",
  "let f = fn n => @int.add n 1;\nreturn f;",
  "Int -> Int",
);

check(
  "performing an operation puts it in the row",
  `const Console = @effect { .write = Str -> Unit; };
let greet = fn name => Console.write name;
return { .greet = greet; };`,
  "{ .greet = Str -> () ~ { Console }; }",
);

check(
  "two effects join into one row",
  `const Console = @effect { .write = Str -> Unit; };
const Clock = @effect { .now = Unit -> Int; };
let stamped = fn name => do
  let t = Clock.now ();
  let _ = Console.write name;
  in t
end;
return { .stamped = stamped; };`,
  "{ .stamped = Str -> Int ~ { Clock, Console }; }",
);

// A wrapper adds its own effect to whatever its callback performs, and the row
// variable is what carries "whatever". Nothing here is annotated.
check(
  "a row variable makes an effect-polymorphic wrapper",
  `const Console = @effect { .write = Str -> Unit; };
let logged = fn f => fn x => do let _ = Console.write "call"; in f x end;
return { .logged = logged; };`,
  "{ .logged = ('a -> 'b ~ { e }) -> 'a -> 'b ~ { Console, e }; }",
);

check(
  "an effect nothing performs stays out of the row",
  `const Console = @effect { .write = Str -> Unit; };
let quiet = fn n => @int.add n 1;
return { .quiet = quiet; };`,
  "{ .quiet = Int -> Int; }",
);

rejects(
  "an unhandled effect at the module boundary is rejected",
  `const Console = @effect { .write = Str -> Unit; };
return Console.write "nobody is listening";`,
  "Nothing handles { Console }",
);

// --- `sig` is checked by subsumption ----------------------------------------

check(
  "a signature narrows what inference would have produced",
  "sig increment = Int -> Int;\nlet increment = fn value => value + 1;\nreturn increment;",
  "Int -> Int",
);

rejects(
  "a signature that disagrees with the body is rejected",
  'sig double = Int -> Int;\nlet double = fn v => @text.concat v "!";\nreturn double;',
  "`Int` is not `Str`",
);

// --- types are values -------------------------------------------------------

check(
  "a `const` whose value is a type is that type",
  "const Bit = 0 | 1;\nsig b = Bit;\nlet b = 1;\nreturn b;",
  "0 | 1",
);

check(
  "a range accepts what it contains",
  "sig small = range (0, 9);\nlet small = 7;\nreturn small;",
  "0..9",
);

rejects(
  "a range rejects what it does not contain",
  "sig small = range (0, 9);\nlet small = 42;\nreturn small;",
  "is outside",
);

// A range names itself. "outside an integer" was true of every range at once,
// which is the one thing the reader already knew.
rejects(
  "a range names the bound the value fell outside of",
  "sig n = Nat;\nlet n = -1;\nreturn n;",
  "`-1` is outside `0..`",
);

// A span reaches the reader. The checker has always had one; until the
// diagnostic carried the file it indexes into, nothing could render it.
Deno.test("a type error renders with a file, line, and column", async () => {
  const path = `${scratch}/located_${crypto.randomUUID()}.blot`;
  await Deno.writeTextFile(
    path,
    PRELUDE +
      "sig greet = Str -> Str;\nlet greet = fn name => name;\nreturn greet 1;\n",
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
  "let runtime = 41;\nconst copied = runtime + 1;\nreturn copied;",
  "BLOT_NOT_COMPTIME",
);

rejects(
  "a comptime expression cannot depend on a runtime binding",
  "let runtime = 41;\nreturn comptime (runtime + 1);",
  "BLOT_NOT_COMPTIME",
);

rejects(
  "a signature cannot float past another declaration",
  "sig answer = Int;\nlet unrelated = 0;\nlet answer = 42;\nreturn answer;",
  "must be immediately followed",
);

rejects(
  "a signature cannot be left without a binding",
  "sig answer = Int;\nreturn 42;",
  "has no adjacent binding",
);

rejects(
  "satisfies is a static constraint when its type is known",
  "const Digit = range (0, 9);\nreturn @satisfies 42 Digit;",
  "is outside",
);

check(
  "a handler result is the common clause result",
  `const Ask = @effect { .ask = Int -> Str; };
let work = fn () => Ask.ask 1;
let text = {
  .ask = fn (_, ?resume) => @text.concat (resume "ok") "!";
  .return = fn value => @text.concat value ".";
};
return @handle (Ask, work, text);`,
  "Str",
);

rejects(
  "resume accepts the operation result type",
  `const Ask = @effect { .ask = Int -> Str; };
let work = fn () => Ask.ask 1;
let wrong = {
  .ask = fn (argument, ?resume) => resume argument;
  .return = fn value => value;
};
return @handle (Ask, work, wrong);`,
  "`Int` is not `Str`",
);

// --- explicit predicative Rank-N -------------------------------------------

check(
  "an explicit forall preserves a polymorphic binding",
  `sig identity = @forall (fn T => T -> T);
let identity = fn value => value;
return identity;`,
  "forall 'q0. 'q0 -> 'q0",
);

check(
  "a Rank-N parameter may be instantiated at two monotypes",
  `sig use = (@forall (fn T => T -> T)) -> { .number = Int; .text = Str; };
let use = fn identity => {
  .number = identity 42;
  .text = identity "forty-two";
};
let identity = fn value => value;
return use identity;`,
  "{ .number = Int; .text = Str; }",
);

rejects(
  "a monomorphic function does not satisfy a Rank-N parameter",
  `sig use = (@forall (fn T => T -> T)) -> { .number = Int; .text = Str; };
let use = fn identity => {
  .number = identity 42;
  .text = identity "forty-two";
};
let increment = fn value => @int.add value 1;
return use increment;`,
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
  `const T = { .x = Int; } <+ { .make = fn n => #Some { .x = n; }; };
let found = T.make 7;
return case found of #Some p => p.x, #None => 0 end;`,
  "(0 | 7)",
);

check(
  "a call to a struct accessor is typed by the storage it reads",
  `const Point = struct { .x = I32; .y = I32; };
let somewhere = Point.new { .y = 20; .x = 10; };
return Point.x somewhere;`,
  "10",
);

check(
  "a member call the checker cannot run knows nothing",
  `const Money = #Money I32 <+ { .of = fn n => #Money n; };
return fn amount => Money.of amount;`,
  "'a -> ⊤",
);

rejects(
  "a sig is not believed for a member call the checker cannot run",
  `const Money = #Money I32 <+ { .of = fn n => #Money n; };
const priced = fn amount => do
  sig converted = Money;
  let converted = Money.of amount;
  in converted
end;
return priced 42;`,
  "anything is not #Money",
);

check(
  "a member that is not a function keeps its own type",
  `const Money = #Money I32 <+ { .zero = #Money 0; };
return Money.zero;`,
  "#Money 0",
);
