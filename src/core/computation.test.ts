import { assertEquals } from "@std/assert";
import { parse } from "../syntax/parse.ts";
import { UNIT } from "../check/type.ts";
import { elaborateModule } from "./computation.ts";

Deno.test("typed core contains settled types and independent expression structure", async () => {
  const parsed = await parse(`let value = ()
return value
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
  const core = elaborateModule(parsed.module, expressionTypes, UNIT, true);
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
  assertEquals(step.definition.value.hirState, {
    tag: "settled",
    typeRep: step.definition.value.typeRep,
    effects: "pure",
    representation: "structural-type-rep",
    ownership: "certified",
    safety: "not-required",
    node: { tag: "static", value: { tag: "unit" } },
  });
  assertEquals(
    core.typeRepresentations.nodes[step.definition.value.typeRep],
    { tag: "unit" },
  );
  assertEquals(core.resultType, UNIT);
  assertEquals(core.hirProgress, {
    settled: 1,
    pending: {
      "structural-fold": 0,
      "specialization-choice": 1,
      "open-representation": 0,
      "ownership-certificate": 0,
    },
  });
});
