import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { UNIT } from "../check/type.ts";
import { elaborateModule, scheduleComputation } from "./computation.ts";

Deno.test("core distinguishes pure definitions from explicit binds", async () => {
  const parsed = await parse(
    "let value = 1;\nresult <- perform value;\nreturn result;",
  );
  if (!parsed.ok) throw new Error("core fixture did not parse");
  const core = scheduleComputation(
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
  const core = scheduleComputation(
    parsed.module.declarations,
    parsed.module.result,
    parsed.module.resultEffects,
  );
  assertEquals(core.result.tag, "tail");
});

Deno.test("core retains an explicit bind whose result is unused", async () => {
  const parsed = await parse(
    "_ <- perform ();\nreturn ();",
  );
  if (!parsed.ok) throw new Error("unused-bind fixture did not parse");
  const core = scheduleComputation(
    parsed.module.declarations,
    parsed.module.result,
    parsed.module.resultEffects,
  );
  assertEquals(core.steps.map((step) => step.tag), ["bind"]);
});

Deno.test("typed core contains settled types and independent expression structure", async () => {
  const parsed = await parse("let value = ();\nreturn value;");
  if (!parsed.ok) throw new Error("typed-core fixture did not parse");
  const declaration = parsed.module.declarations[0];
  if (declaration?.tag !== "binding") {
    throw new Error("typed-core fixture omitted its binding");
  }
  const expressionTypes = new Map([
    [declaration.value, UNIT],
    [parsed.module.result, UNIT],
  ]);
  const core = elaborateModule(parsed.module, expressionTypes, UNIT);
  assertEquals(core.steps[0]?.tag, "define");
  const step = core.steps[0];
  if (step === undefined) {
    throw new Error("typed Core omitted its live definition");
  }
  assertEquals(step.definition.value.tag, "unit");
  assertEquals(step.definition.value.type, UNIT);
  assertEquals(
    core.typeRepresentations.nodes[step.definition.value.typeRep],
    { tag: "unit" },
  );
  assertEquals(core.resultType, UNIT);
});
