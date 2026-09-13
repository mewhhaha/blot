import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { RuntimeValue } from "../abi_values.ts";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";
import { evaluationObservation } from "../runtime_observation.ts";
import { observeArtifact } from "./run.ts";

function record(...fields: [string, RuntimeValue][]): RuntimeValue {
  return { kind: "record", fields: new Map(fields) };
}

function ok(payload: bigint): RuntimeValue {
  return { kind: "variant", name: "Ok", payload };
}

function failure(name: string, payload?: RuntimeValue): RuntimeValue {
  let error: RuntimeValue = { kind: "variant", name };
  if (payload !== undefined) error = { ...error, payload };
  return { kind: "variant", name: "Error", payload: error };
}

test("source integer parsing handles every radix, exact limits and structured failures", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-runtime-integers.blot";
    await compiler.checkSource(
      path,
      `const Parse = import "blot:parse"
return { .integer = Parse.integer; .radix = Parse.integer_radix; }
`,
    );
    const guest = await instantiateArtifact(await compiler.compile(path));
    try {
      const integers = [
        0n,
        1n,
        -1n,
        42n,
        -42n,
        9223372036854775807n,
        -9223372036854775808n,
      ];
      let seed = 123456789n;
      for (let index = 0; index < 20; index += 1) {
        seed = BigInt.asIntN(
          64,
          seed * 6364136223846793005n + 1442695040888963407n,
        );
        integers.push(seed);
      }
      for (let radix = 2; radix <= 36; radix += 1) {
        for (const value of integers) {
          for (
            const text of [
              value.toString(radix),
              value.toString(radix).toUpperCase(),
            ]
          ) {
            assert.deepEqual(
              guest.call("radix", [record(["0", text], ["1", BigInt(radix)])]),
              ok(value),
            );
          }
        }
      }
      for (
        const [text, expected] of [
          ["+42", ok(42n)],
          ["-0", ok(0n)],
          ["0".repeat(32768) + "42", ok(42n)],
          ["", failure("EmptyInput")],
          ["+", failure("EmptyInput")],
          ["-", failure("EmptyInput")],
          [
            " 42",
            failure("InvalidDigit", record(["position", 0n], ["scalar", " "])),
          ],
          [
            "12🐱",
            failure("InvalidDigit", record(["position", 2n], ["scalar", "🐱"])),
          ],
          [
            "0x10",
            failure("InvalidDigit", record(["position", 1n], ["scalar", "x"])),
          ],
          [
            "1_000",
            failure("InvalidDigit", record(["position", 1n], ["scalar", "_"])),
          ],
          [
            "9223372036854775808",
            failure("IntegerOverflow", record(["position", 18n])),
          ],
          [
            "-9223372036854775809",
            failure("IntegerOverflow", record(["position", 19n])),
          ],
        ] as const
      ) assert.deepEqual(guest.call("integer", [text]), expected);
      for (const radix of [-1n, 0n, 1n, 37n, 9223372036854775807n]) {
        assert.deepEqual(
          guest.call("radix", [record(["0", ""], ["1", radix])]),
          failure("InvalidRadix", radix),
        );
      }
    } finally {
      await guest.close();
    }
    for (
      const path of [
        "examples/parse_integer.blot",
        "examples/command_codec.blot",
        "examples/module_input_contract.blot",
      ]
    ) {
      const evaluated = await compiler.evaluate(path);
      const emitted = await observeArtifact(await compiler.compile(path));
      assert.deepEqual(
        evaluationObservation(evaluated.value, emitted.type),
        emitted.value,
        path,
      );
    }
    const dependency = resolve("examples/lib/checked_module_input.blot");
    await assert.rejects(
      () =>
        compiler.checkSource(
          "/tmp/blot-invalid-module-input.blot",
          `const configured = import ${
            JSON.stringify(dependency)
          } with { .prefix = "count="; .count = "wrong"; }
return configured.render ()
`,
        ),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});
