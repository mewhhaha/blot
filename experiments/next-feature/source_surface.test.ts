import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { Compiler } from "../../src/compiler.ts";
import { BlotError } from "../../src/diagnostic.ts";
import { evaluateFile } from "../../src/run.ts";

const effectStream = fromFileUrl(
  new URL("./effect_stream_example.blot", import.meta.url),
);
const derivedAccessors = fromFileUrl(
  new URL("./derived_accessors_example.blot", import.meta.url),
);
const effectStreamCombinators = fromFileUrl(
  new URL("./effect_stream_combinators.blot", import.meta.url),
);

Deno.test("effect handlers compose a producer transformer and consumer", async () => {
  const result = await evaluateFile(effectStream, { write() {} });
  assertEquals(result, { tag: "int", value: 12n });
});

Deno.test("comptime reflection derives statically named accessors", async () => {
  const result = await evaluateFile(derivedAccessors, { write() {} });
  assertEquals(result, {
    tag: "shape",
    fields: [
      ["name", { tag: "text", value: "Ada" }],
      ["score", { tag: "int", value: 42n }],
    ],
  });
});

Deno.test("imported handler builders lose continuation qualifier provenance", async () => {
  const compiler = await Compiler.create();
  try {
    try {
      await compiler.check(effectStreamCombinators);
      throw new Error("expected imported handler clauses to be rejected");
    } catch (error) {
      assert(error instanceof BlotError);
      assertEquals(
        error.diagnostic.code,
        "BLOT_HANDLER_RESUME_NOT_AFFINE",
      );
    }
  } finally {
    compiler.destroy();
  }
});
