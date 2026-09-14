import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeValue } from "../abi_values.ts";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";

function record(fields: Record<string, RuntimeValue>): RuntimeValue {
  return { kind: "record", fields: new Map(Object.entries(fields)) };
}

test("fresh record results keep their own layouts after wider arguments", async () => {
  const compiler = await Compiler.create();
  try {
    const checkedInterface1 = await compiler.check(
      "examples/lib/record_view_results.blot",
    );
    assert.deepEqual({
      type: checkedInterface1.type,
      effects: checkedInterface1.effects,
    }, {
      type: "Int -> { .0 = { .count = Int }; .1 = { .count = Text } }",
      effects: "",
    });
    const guest = await instantiateArtifact(
      await compiler.compile("examples/lib/record_view_results.blot"),
    );
    try {
      for (const count of [-999n, 0n, 41n, 1_000_000n]) {
        assert.deepEqual(
          guest.call("default", [count]),
          record({
            "0": record({ count: count + 1n }),
            "1": record({ count: String(count) }),
          }),
        );
      }
    } finally {
      guest.destroy();
    }
  } finally {
    compiler.destroy();
  }
});
