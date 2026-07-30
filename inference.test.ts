// Principal types, asserted as strings.
//
// This is the point of writing them down: a lattice change that widens an
// inferred type shows up here as a diff rather than as "still compiles". A test
// that only checked "no error" would pass just as happily with a checker that
// inferred `⊤` for everything.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { checkFile } from "./src/check/mod.ts";
import { BlotError } from "./src/diagnostic.ts";

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
  "identity preserves the singleton",
  "let identity = x => x;\nreturn identity 42;",
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
  "let identity = x => x;\nreturn identity;",
  "'a -> 'a",
);

check(
  "one binding instantiates independently per use",
  'let identity = x => x;\nreturn { .a = identity 1; .b = identity "two"; };',
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
  'let identity = x => x;\nidentity := x => x;\nreturn { .number = identity 1; .text = identity "two"; };',
  '{ .number = 1; .text = "two"; }',
);

check(
  "an unconditional early return determines the function result",
  "let answer = () => do\n  return 42;\nend;\nreturn answer;",
  "() -> 42",
);

check(
  "a statement conditional returns from its function",
  'let describe = value => do\n  if value < 0 then do\n    return "negative";\n  end;\n  in "positive"\nend;\nreturn describe;',
  'Int -> ("negative" | "positive")',
);

check(
  "a return crosses a for loop",
  "let find = wanted => do\n  for value in Iter.range (0, 5) do\n    if value == wanted then do\n      return value;\n    end;\n  end;\n  in -1\nend;\nreturn find;",
  "Int -> (Int | 0 | -1)",
);

check(
  "a return crosses an unbounded loop",
  "let count_to = limit => do\n  let count = 0;\n  for ever do\n    count := count + 1;\n    if count >= limit then do\n      return count;\n    end;\n  end;\n  in 0\nend;\nreturn count_to;",
  "Int -> (Int | 0)",
);

rejects(
  "rebinding requires an existing name",
  "missing := 1;\nreturn missing;",
  "cannot shadow a name that is not in scope",
);

check(
  "a curried section keeps its remaining parameter",
  "let add = a => (b => @int.add a b);\nreturn add 2;",
  "Int -> Int",
);

// Not `('a -> 'a) -> 'a -> 'a`. Hindley-Milner has to unify the two uses of `f`;
// with subtyping the principal type is their intersection, which is strictly
// more general. Writing the expected string down is what caught the assumption.
check(
  "applying a parameter twice intersects its two uses",
  "let twice = f => (x => f (f x));\nreturn twice;",
  "('a -> 'b ~ { e } & 'b -> 'c ~ { e }) -> 'a -> 'c ~ { e }",
);

// --- records: width subtyping is the whole of a `duck` contract --------------

check(
  "a projection constrains only the field it reaches for",
  "let width = shape => shape.w;\nreturn width;",
  "{ .w = 'a; } -> 'a",
);

check(
  "two projections accumulate one record constraint",
  "let area = s => @int.mul s.w s.h;\nreturn area;",
  "{ .w = Int; .h = Int; } -> Int",
);

rejects(
  "a missing field is an ordinary constraint failure",
  "let area = s => @int.mul s.w s.h;\nreturn area { .w = 2; };",
  "no field `.h`",
);

// --- variants, unions, and narrowing ----------------------------------------

check(
  "a case joins its arms",
  "let f = m => case m of #Ready => 1, #Failed r => r end;\nreturn f;",
  "#Ready | #Failed 'a -> ('a | 1)",
);

check(
  "an unmatched branch keeps the parameter open",
  "let f = (flag, other) => case flag of #No => #Off, #Yes => other end;\nreturn f;",
  "(#No | #Yes, 'a) -> ('a | #Off)",
);

rejects(
  "a constructor no arm covers is rejected",
  'let f = m => case m of #Ready => 1, #Busy n => n end;\nreturn f (#Failed "x");',
  "`#Failed` is not one of",
);

rejects(
  "a declared literal union rejects a value outside it",
  "sig level = 1 | 2 | 3;\nlet level = 7;\nreturn level;",
  "7 is not one of 1 | 2 | 3",
);

// --- effects are a lattice element, not a separate pass ---------------------

check(
  "a pure function has no row",
  "let f = n => @int.add n 1;\nreturn f;",
  "Int -> Int",
);

check(
  "performing an operation puts it in the row",
  `const Console = @effect { .write = Str -> Unit; };
let greet = name => Console.write name;
return { .greet = greet; };`,
  "{ .greet = Text -> () ~ { Console }; }",
);

check(
  "two effects join into one row",
  `const Console = @effect { .write = Str -> Unit; };
const Clock = @effect { .now = Unit -> Int; };
let stamped = name => do
  let t = Clock.now ();
  let _ = Console.write name;
  in t
end;
return { .stamped = stamped; };`,
  "{ .stamped = Text -> Int ~ { Clock, Console }; }",
);

// A wrapper adds its own effect to whatever its callback performs, and the row
// variable is what carries "whatever". Nothing here is annotated.
check(
  "a row variable makes an effect-polymorphic wrapper",
  `const Console = @effect { .write = Str -> Unit; };
let logged = f => (x => do let _ = Console.write "call"; in f x end);
return { .logged = logged; };`,
  "{ .logged = ('a -> 'b ~ { e }) -> 'a -> 'b ~ { Console, e }; }",
);

check(
  "an effect nothing performs stays out of the row",
  `const Console = @effect { .write = Str -> Unit; };
let quiet = n => @int.add n 1;
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
  "sig increment = Int -> Int;\nlet increment = value => value + 1;\nreturn increment;",
  "Int -> Int",
);

rejects(
  "a signature that disagrees with the body is rejected",
  'sig double = Int -> Int;\nlet double = v => @text.concat v "!";\nreturn double;',
  "an integer is not text",
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
let work = () => Ask.ask 1;
let text = {
  .ask = (_, ?resume) => @text.concat (resume "ok") "!";
  .return = value => @text.concat value ".";
};
return @handle (Ask, work, text);`,
  "Text",
);

rejects(
  "resume accepts the operation result type",
  `const Ask = @effect { .ask = Int -> Str; };
let work = () => Ask.ask 1;
let wrong = {
  .ask = (argument, ?resume) => resume argument;
  .return = value => value;
};
return @handle (Ask, work, wrong);`,
  "an integer is not text",
);

// --- explicit predicative Rank-N -------------------------------------------

check(
  "an explicit forall preserves a polymorphic binding",
  `sig identity = @forall (T => T -> T);
let identity = value => value;
return identity;`,
  "forall 'q0. 'q0 -> 'q0",
);

check(
  "a Rank-N parameter may be instantiated at two monotypes",
  `sig use = (@forall (T => T -> T)) -> { .number = Int; .text = Str; };
let use = identity => {
  .number = identity 42;
  .text = identity "forty-two";
};
let identity = value => value;
return use identity;`,
  "{ .number = Int; .text = Text; }",
);

rejects(
  "a monomorphic function does not satisfy a Rank-N parameter",
  `sig use = (@forall (T => T -> T)) -> { .number = Int; .text = Str; };
let use = identity => {
  .number = identity 42;
  .text = identity "forty-two";
};
let increment = value => @int.add value 1;
return use increment;`,
  "rigid type",
);
