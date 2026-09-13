import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeValue } from "../abi_values.ts";
import { Compiler } from "../compiler.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";

function variant(name: string, payload: RuntimeValue): RuntimeValue {
  return { kind: "variant", name, payload };
}

test("heterogeneous variants preserve nested payload bits, storage and suspension", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "examples/lib/variant_lanes.blot";
    const observed: RuntimeValue[] = [];
    const copy: HostOperation = async (_context, value) => {
      observed.push(value);
      return await Promise.resolve(value);
    };
    const guest = await instantiateArtifact(
      await compiler.compile(path),
      new Map([
        ["Echo", new Map([["copy", copy]])],
      ]),
    );
    try {
      const numbers = [
        variant("Integer", -9223372036854775808n),
        variant("Integer", 9223372036854775807n),
        variant("Single", Math.fround(0.1)),
        variant("Single", -0),
        variant("Double", -0),
        variant("Double", Infinity),
        variant("Double", NaN),
        variant("Flag", false),
        variant("Flag", true),
      ];
      for (const value of numbers) {
        assert.deepEqual(guest.call("number", [value]), value);
      }
      const values = [
        ...numbers.map((value) => variant("Number", value)),
        variant("Text", "nested 🐱 payload"),
        variant("Array", numbers),
      ];
      for (const value of values) {
        assert.deepEqual(guest.call("mixed", [value]), value);
        assert.deepEqual(await guest.callAsync("echo", [value]), value);
      }
      for (let iteration = 0; iteration < 50; iteration += 1) {
        assert.deepEqual(guest.call("store", [values]), values);
      }
      assert.deepEqual(observed, values);
    } finally {
      await guest.close();
    }
  } finally {
    compiler.destroy();
  }
});
