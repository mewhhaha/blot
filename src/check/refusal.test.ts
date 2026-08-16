// Where a refusal is reported.
//
// `@fail` runs inside whichever module defined the predicate, so a refusal from
// the prelude's `expect` carries a prelude offset. The module being checked is
// the one that claims the origin, so that pair used to render as a line past
// the end of the user's file — a location that does not exist and that the user
// could not act on even if it did. The message belongs to the program; the
// location belongs to whatever the user wrote to trigger it.

import { assertEquals } from "@std/assert";
import { checkFile } from "./mod.ts";
import { BlotError, locate } from "../diagnostic.ts";

async function refusalAt(source: string): Promise<{
  line: number;
  lines: number;
  message: string;
}> {
  const path = await Deno.makeTempFile({ suffix: ".blot" });
  try {
    await Deno.writeTextFile(path, source);
    try {
      await checkFile(path);
    } catch (error) {
      if (!(error instanceof BlotError)) throw error;
      assertEquals(error.diagnostic.code, "BLOT_REFUSED");
      const origin = error.origin;
      if (origin === null) {
        throw new Error("a refusal reached the user unowned");
      }
      return {
        line: locate(origin.source, error.diagnostic.span.start).line,
        lines: origin.source.trimEnd().split("\n").length,
        message: error.diagnostic.message,
      };
    }
    throw new Error("expected this program to be refused");
  } finally {
    await Deno.remove(path);
  }
}

Deno.test("a refusal from the prelude points at the caller, not the prelude", async () => {
  const found = await refusalAt(
    `open import "blot:prelude"
` +
      `const _ = expect (False, "nope")
` +
      `return 1
`,
  );
  assertEquals(found.message, "nope");
  // The `expect` call, not an offset into `prelude.blot`.
  assertEquals(found.line, 2);
  assertEquals(found.line <= found.lines, true);
});

Deno.test("a refusal from a `@type.satisfies` predicate points at the predicate", async () => {
  const found = await refusalAt(
    `open import "blot:prelude"
` +
      `let reading = { .value = 12; }
` +
      `let _ = @type.satisfies (reading, fn t =>\n` +
      `  return expect (refines (t, Has { .missing = Int; }), "needs .missing")\n` +
      `)\n` +
      `return reading.value
`,
  );
  assertEquals(found.message, "needs .missing");
  assertEquals(found.line, 3);
  assertEquals(found.line <= found.lines, true);
});
