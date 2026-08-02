import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { elaborateComputation } from "./computation.ts";

Deno.test("core distinguishes pure definitions from explicit binds", async () => {
  const parsed = await parse(
    "let value = 1;\nresult <- perform value;\nreturn result;",
  );
  if (!parsed.ok) throw new Error("core fixture did not parse");
  const core = elaborateComputation(
    parsed.module.declarations,
    parsed.module.result,
    parsed.module.resultEffects,
  );
  assertEquals(core.steps.map((step) => step.tag), ["define", "bind"]);
  assertEquals(core.result.tag, "return");
});

Deno.test("core marks an ambient block result as a tail computation", async () => {
  const parsed = await parse(
    "if #True then do return (); end;\nreturn ();",
  );
  if (!parsed.ok) throw new Error("tail-computation fixture did not parse");
  const core = elaborateComputation(
    parsed.module.declarations,
    parsed.module.result,
    parsed.module.resultEffects,
  );
  assertEquals(core.result.tag, "tail");
});
