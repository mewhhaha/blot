import { assertEquals } from "@std/assert";
import { Compiler } from "./session.ts";
import { parse } from "../syntax/parse.ts";
import { decodePortableModule } from "../syntax/portable.ts";

Deno.test("tooling and Rust normalize representative source to the same AST", async () => {
  const paths = [
    "examples/loops.blot",
    "examples/operators.blot",
    "examples/short_circuit.blot",
    "examples/polymorphic_collections.blot",
    "examples/inline_signatures.blot",
    "examples/continuing.blot",
    "examples/numeric_literals.blot",
  ];
  const compiler = await Compiler.create();
  try {
    for (const path of paths) {
      const source = await Deno.readTextFile(path);
      const tooling = await parse(source);
      if (!tooling.ok) throw new Error(`${path} did not parse in tooling`);
      const rust = decodePortableModule(
        JSON.parse(await compiler.portableAst(path)),
        path,
      );
      assertEquals(rust, tooling.module, path);
    }
  } finally {
    compiler.destroy();
  }
});
