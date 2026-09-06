import assert from "node:assert/strict";
import test from "node:test";
import type { BlotAbiType } from "./abi.ts";
import { AbiMemoryLayouts } from "./memory_layout.ts";

test("ABI layouts preserve scalar, empty, sealed, and pointer-pair layouts", () => {
  const layouts = new AbiMemoryLayouts();
  for (
    const [type, expected] of [
      [{ kind: "unit" }, [1, 0]],
      [{ kind: "boolean" }, [1, 1]],
      [{ kind: "float-32" }, [4, 4]],
      [{ kind: "float-64" }, [8, 8]],
      [{ kind: "signed-integer-64" }, [8, 8]],
      [{ kind: "text" }, [4, 8]],
      [{ kind: "array", element: { kind: "unit" } }, [4, 8]],
      [{ kind: "record", fields: [] }, [1, 0]],
      [{ kind: "sealed", name: "Wrapped", inner: { kind: "float-64" } }, [
        8,
        8,
      ]],
    ] as const
  ) {
    const actual = layouts.get(type);
    assert.deepEqual([actual.alignment, actual.size], expected);
    assert.strictEqual(layouts.get(type), actual);
  }
});

test("record offsets use canonical code-unit order and retain tail padding", () => {
  const type = {
    kind: "record",
    fields: [
      { name: "z", type: { kind: "boolean" } },
      { name: "b", type: { kind: "signed-integer-64" } },
      { name: "a", type: { kind: "boolean" } },
    ],
  } as const;
  const layout = new AbiMemoryLayouts().get(type);
  assert.deepEqual(layout.fields.map(({ name, offset }) => [name, offset]), [
    ["a", 0],
    ["b", 8],
    ["z", 16],
  ]);
  assert.deepEqual([layout.alignment, layout.size], [8, 24]);
  assert.deepEqual(type.fields.map(({ name }) => name), ["z", "b", "a"]);
  const unicode = new AbiMemoryLayouts().get({
    kind: "record",
    fields: [
      { name: "\ue000", type: { kind: "unit" } },
      { name: "🌳", type: { kind: "unit" } },
    ],
  });
  assert.deepEqual(unicode.fields.map(({ name }) => name), ["🌳", "\ue000"]);
});

test("variant layout retains discriminant thresholds and aligned payloads", () => {
  const layouts = new AbiMemoryLayouts();
  for (
    const [count, width] of [[1, 1], [256, 1], [257, 2], [65_536, 2], [
      65_537,
      4,
    ]]
  ) {
    const type = {
      kind: "variant",
      cases: Array.from({ length: count }, (_, index) => ({
        name: String(index).padStart(5, "0"),
      })),
    } as const;
    const layout = layouts.get(type);
    assert.equal(layout.discriminantSize, width);
    assert.equal(layout.size, width);
  }
  const type = {
    kind: "variant",
    cases: [
      { name: "Some", payload: { kind: "signed-integer-64" } },
      { name: "None" },
    ],
  } as const;
  const layout = layouts.get(type);
  assert.deepEqual(
    [
      layout.discriminantSize,
      layout.payloadOffset,
      layout.alignment,
      layout.size,
    ],
    [1, 8, 8, 16],
  );
  assert.deepEqual(layout.cases.map(({ name }) => name), ["None", "Some"]);
  assert.deepEqual(type.cases.map(({ name }) => name), ["Some", "None"]);
});

test("nested layouts read each field type once, not exponentially", () => {
  let reads = 0;
  let type: BlotAbiType = { kind: "text" };
  const depth = 64;
  for (let index = 0; index < depth; index += 1) {
    const inner: BlotAbiType = type;
    type = {
      kind: "record",
      fields: [{
        name: "value",
        get type(): BlotAbiType {
          reads += 1;
          return inner;
        },
      }],
    };
  }
  const layouts = new AbiMemoryLayouts();
  const layout = layouts.get(type);
  assert.deepEqual([layout.alignment, layout.size], [4, 8]);
  assert.equal(reads, depth);
  assert.strictEqual(layouts.get(type), layout);
  assert.equal(reads, depth);
});

test("shared immutable descriptors reuse layout without sharing value storage", () => {
  const element = Object.freeze(
    {
      kind: "record",
      fields: Object.freeze([
        Object.freeze({ name: "value", type: Object.freeze({ kind: "text" }) }),
      ]),
    } as const,
  );
  const layouts = new AbiMemoryLayouts();
  const first = layouts.get(element);
  const array = layouts.get({ kind: "array", element });
  assert.deepEqual([array.alignment, array.size], [4, 8]);
  assert.strictEqual(layouts.get(element), first);
  assert.notStrictEqual(new AbiMemoryLayouts().get(element), first);
});
