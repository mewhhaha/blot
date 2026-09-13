import assert from "node:assert/strict";
import test from "node:test";
import { evaluationObservation } from "./runtime_observation.ts";

test("observations preserve IEEE values independently of JSON/display spellings", () => {
  const single = (bits: string) =>
    evaluationObservation({ tag: "float32", bits, value: null }, {
      kind: "float-32",
    });
  const double = (bits: string) =>
    evaluationObservation({ tag: "float", bits, value: null }, {
      kind: "float-64",
    });
  assert.equal(single("3dcccccd"), Math.fround(0.1));
  assert.ok(Object.is(single("80000000"), -0));
  assert.ok(Object.is(double("8000000000000000"), -0));
  assert.equal(double("7ff0000000000000"), Infinity);
  assert.equal(double("fff0000000000000"), -Infinity);
  assert.ok(Number.isNaN(single("7fc00000")));
  assert.ok(Number.isNaN(double("7ff8000000000000")));
  assert.throws(() => single("0"), /Invalid evaluated/);
  assert.throws(
    () =>
      evaluationObservation({ tag: "float", value: 0 }, { kind: "float-64" }),
    /Invalid evaluated/,
  );
});

test("observations compare records by fields and Unicode by actual scalar text", () => {
  const encoded = {
    tag: "shape",
    fields: [["z", { tag: "text", value: "e\u0301" }], ["a", {
      tag: "int",
      value: "9223372036854775807",
    }]],
  };
  assert.deepEqual(
    evaluationObservation(encoded, {
      kind: "record",
      fields: [{ name: "a", type: { kind: "signed-integer-64" } }, {
        name: "z",
        type: { kind: "text" },
      }],
    }),
    {
      kind: "record",
      fields: new Map<string, bigint | string>([["a", 9223372036854775807n], [
        "z",
        "é",
      ]]),
    },
  );
  assert.throws(
    () => evaluationObservation(encoded, { kind: "record", fields: [] }),
    /fields differ/,
  );
});

test("observations preserve constructor payloads and refuse missing or invalid evidence", () => {
  const type = {
    kind: "variant",
    cases: [{ name: "Some", payload: { kind: "signed-integer-64" } }, {
      name: "None",
    }],
  } as const;
  assert.deepEqual(
    evaluationObservation({
      tag: "tag",
      name: "Some",
      payload: { tag: "int", value: "7" },
    }, type),
    { kind: "variant", name: "Some", payload: 7n },
  );
  assert.throws(
    () =>
      evaluationObservation({ tag: "tag", name: "Some", payload: null }, type),
    /Expected an evaluated/,
  );
  assert.throws(
    () =>
      evaluationObservation({
        tag: "tag",
        name: "None",
        payload: { tag: "unit" },
      }, type),
    /Unexpected payload/,
  );
  assert.throws(
    () =>
      evaluationObservation({ tag: "int", value: "9223372036854775808" }, {
        kind: "signed-integer-64",
      }),
    /Invalid evaluated/,
  );
});
