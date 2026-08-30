import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { decodeQCoreSchema, generateQCore } from "./generate_qcore.ts";

const schemaSource = await Deno.readTextFile("qcore/schema.json");

Deno.test("QCore schema reproduces every checked-in target", async () => {
  const schema: unknown = JSON.parse(schemaSource);
  const outputs = generateQCore(decodeQCoreSchema(schema));

  assertEquals(
    outputs.rust,
    await Deno.readTextFile("compiler/src/qcore_generated.rs"),
  );
  assertEquals(
    outputs.typescript,
    await Deno.readTextFile("src/qcore_generated.ts"),
  );
  assertEquals(
    outputs.lean,
    await Deno.readTextFile("formal/lean/Blot/QCoreGenerated.lean"),
  );
});

Deno.test("QCore constructor tags agree across Rust, TypeScript, and Lean", () => {
  const source: unknown = JSON.parse(schemaSource);
  const schema = decodeQCoreSchema(source);
  const outputs = generateQCore(schema);

  for (const union of schema.unions) {
    for (const variant of union.variants) {
      assertStringIncludes(
        outputs.rust,
        `${variant.name} = ${variant.tag},`,
      );
      assertStringIncludes(
        outputs.typescript,
        `${variant.name} = ${variant.tag},`,
      );
      assertStringIncludes(
        outputs.lean,
        `| .${variant.name} => ${variant.tag}`,
      );
    }
  }
});

Deno.test("QCore list fields use each target's immutable collection shape", () => {
  const source: unknown = JSON.parse(schemaSource);
  const outputs = generateQCore(decodeQCoreSchema(source));

  assertStringIncludes(outputs.rust, "pub values: Vec<ValueNode>,");
  assertStringIncludes(
    outputs.typescript,
    "readonly values: readonly ValueNode[];",
  );
  assertStringIncludes(outputs.lean, "«values» : List ValueNode");
});

Deno.test("QCore booleans use each target's native type", () => {
  const source: unknown = JSON.parse(schemaSource);
  const outputs = generateQCore(decodeQCoreSchema(source));

  assertStringIncludes(outputs.rust, "deferred: bool,");
  assertStringIncludes(outputs.typescript, "readonly deferred: boolean;");
  assertStringIncludes(outputs.lean, "(«deferred» : Bool)");
});

Deno.test("QCore Lean fields quote every schema identifier", () => {
  const source: unknown = JSON.parse(schemaSource);
  const outputs = generateQCore(decodeQCoreSchema(source));

  assertStringIncludes(outputs.rust, "universe: Universe,");
  assertStringIncludes(outputs.typescript, "readonly universe: Universe;");
  assertStringIncludes(outputs.lean, "(«universe» : Universe)");
  assertStringIncludes(outputs.lean, "(«deferred» : Bool)");
  assertStringIncludes(outputs.lean, "  «values» : List ValueNode");
  assertStringIncludes(outputs.lean, "  «value» : UInt32");
});

Deno.test("QCore schema rejects a field with no declared type", () => {
  const malformedSource = schemaSource.replace(
    '"type": "ValueId"',
    '"type": "MissingType"',
  );
  const malformedSchema: unknown = JSON.parse(malformedSource);

  assertThrows(
    () => decodeQCoreSchema(malformedSchema),
    Error,
    "refers to unknown type MissingType",
  );
});

Deno.test("QCore schema rejects non-dense constructor tags", () => {
  const malformedSource = schemaSource.replace(
    '"name": "Prop", "tag": 1',
    '"name": "Prop", "tag": 3',
  );
  const malformedSchema: unknown = JSON.parse(malformedSource);

  assertThrows(
    () => decodeQCoreSchema(malformedSchema),
    Error,
    "tag 3 must equal its dense position 1",
  );
});
