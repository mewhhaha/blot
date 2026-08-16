import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { UNIT } from "../check/type.ts";
import { elaborateModule } from "./computation.ts";

Deno.test("typed core contains settled types and independent expression structure", async () => {
  const parsed = await parse(`let value = ()
export value
`);
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
  if (step.definition.tag !== "binding") {
    throw new Error("typed Core changed a binding into another definition");
  }
  assertEquals(step.definition.value.tag, "unit");
  assertEquals(step.definition.value.type, UNIT);
  assertEquals(
    core.typeRepresentations.nodes[step.definition.value.typeRep],
    { tag: "unit" },
  );
  assertEquals(core.resultType, UNIT);
});
