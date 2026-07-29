// Linearity and ownership.
//
// `!` is exactly-once, not at-most-once, so both failures are tested: spending
// a value twice and never spending it at all. The second is the one a weaker
// rule would let through, and it is the leak the marker exists to catch.

import { assertEquals, assertStringIncludes } from "@std/assert";
import { checkFile } from "./src/check/mod.ts";
import { BlotError } from "./src/diagnostic.ts";

const scratch = await Deno.makeTempDir();

// Every snippet opens the prelude, because every module does: it has no
// privilege, and a fixture that skipped it would be testing a language where
// `+` is unbound.
const PRELUDE = 'open (@import "blot:prelude") ();\n';

async function analyze(source: string) {
  const path = `${scratch}/case_${crypto.randomUUID()}.blot`;
  await Deno.writeTextFile(path, PRELUDE + source);
  return await checkFile(path);
}

function accepts(name: string, source: string): void {
  Deno.test(name, async () => {
    await analyze(source);
  });
}

function rejects(name: string, source: string, code: string): void {
  Deno.test(name, async () => {
    try {
      await analyze(source);
    } catch (error) {
      if (!(error instanceof BlotError)) throw error;
      assertStringIncludes(error.message, code);
      return;
    }
    throw new Error("expected this program to be rejected");
  });
}

const CONSUME = "let consume = (!value) => @int.add value 1;\n";

accepts(
  "a linear value consumed once is accepted",
  `${CONSUME}let !token = 41;\nreturn consume (!token);`,
);

rejects(
  "spending a linear value twice is rejected",
  `${CONSUME}let !token = 41;
return @int.add (consume (!token)) (consume (!token));`,
  "BLOT_LINEAR_CONSUMED_TWICE",
);

rejects(
  "never spending a linear value is rejected",
  "let !handle = 41;\nreturn 0;",
  "BLOT_LINEAR_NOT_CONSUMED",
);

accepts(
  "branches that both consume agree",
  `${CONSUME}let !token = 41;
return if 1 < 2 then consume (!token) else consume (!token) end;`,
);

rejects(
  "branches that disagree about consuming are rejected",
  `${CONSUME}let !token = 41;
return if 1 < 2 then consume (!token) else 0 end;`,
  "BLOT_LINEAR_BRANCH_DISAGREEMENT",
);

// Capturing does not refuse and does not spend in place: the obligation moves
// into the closure, which becomes linear itself. `go` is linear because of what
// it holds, not because anyone wrote `!` on it.
accepts(
  "a closure capturing a linear value is linear, and one call discharges it",
  `${CONSUME}let !token = 41;
let go = () => consume (!token);
return go ();`,
);

rejects(
  "calling a linear closure twice is rejected",
  `${CONSUME}let !token = 41;
let go = () => consume (!token);
return @int.add (go ()) (go ());`,
  "BLOT_LINEAR_CONSUMED_TWICE",
);

rejects(
  "a linear closure nobody calls leaks what it captured",
  `${CONSUME}let !token = 41;
let go = () => consume (!token);
return 0;`,
  "BLOT_LINEAR_NOT_CONSUMED",
);

rejects(
  "spending a capture twice inside the body is still caught",
  `${CONSUME}let !token = 41;
let go = () => @int.add (consume (!token)) (consume (!token));
return go ();`,
  "BLOT_LINEAR_CONSUMED_TWICE",
);

rejects(
  "storing a linear closure in a shape is reported, not lost",
  `${CONSUME}let !token = 41;
return { .go = () => consume (!token); };`,
  "BLOT_LINEAR_CLOSURE_ESCAPES",
);

// A borrow reads without spending, which is the whole reason to have one.
accepts(
  "a borrowed parameter may be projected",
  "let peek = (&p) => @int.add p.x p.y;\nreturn peek { .x = 1; .y = 2; };",
);

rejects(
  "a borrowed parameter may not be moved",
  "let steal = (&p) => p;\nreturn steal { .x = 1; };",
  "BLOT_BORROW_MOVED",
);

// `?` is affine — at most once. Not a weaker `!`: the difference is whether
// *not* spending is a leak or an abort, and for a continuation it is an abort.

accepts(
  "an affine value spent once is accepted",
  "let once = (?r) => r 1;\nreturn once (x => x);",
);

accepts(
  "an affine value never spent is accepted, unlike a linear one",
  "let never = (?r) => 0;\nreturn never (x => x);",
);

rejects(
  "spending an affine value twice is rejected",
  "let twice = (?r) => @int.add (r 1) (r 2);\nreturn twice (x => x);",
  "BLOT_LINEAR_CONSUMED_TWICE",
);

accepts(
  "affine branches need not agree, because either way it is at most once",
  "let some = (?r) => if 1 < 2 then r 1 else 0 end;\nreturn some (x => x);",
);

// The facts the backend will consume. Nothing applies them yet — an in-place
// rewrite needs a Core to rewrite — so they are asserted directly instead.
// Both the parameter and the binding: `(!value) => ...` is as linear as
// `let !token`, and the pass proves each of them spent exactly once.
Deno.test("every linear binding proved spent is recorded", async () => {
  const checked = await analyze(
    `${CONSUME}let !token = 41;\nreturn consume (!token);`,
  );
  assertEquals([...checked.ownership.linear].sort(), ["token", "value"]);
});

Deno.test("the last use of each binding is recorded", async () => {
  const checked = await analyze(
    "let a = 1;\nlet b = @int.add a 2;\nreturn @int.add b 3;",
  );
  assertEquals([...checked.ownership.lastUses.keys()].sort(), ["a", "b"]);
});
