import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";
import { evaluationObservation } from "../runtime_observation.ts";
import { observeArtifact } from "./run.ts";

function significantDigits(text: string): number {
  return text.split("e")[0].replace(/[-.]/g, "").replace(/^0+|0+$/g, "").length;
}

function shortestBinary32Digits(value: number): number {
  for (let precision = 1; precision <= 9; precision += 1) {
    const [coefficient, exponent] = Math.abs(value).toExponential(precision - 1)
      .split("e");
    const digits = BigInt(coefficient.replace(".", ""));
    const power = Number(exponent) - precision + 1;
    for (const offset of [-1n, 0n, 1n]) {
      const candidate = Number(`${digits + offset}e${power}`);
      if (Math.fround(candidate) === Math.abs(value)) return precision;
    }
  }
  throw new Error(`No nine-digit decimal round trip for ${value}`);
}

test("pure float formatting handles both precisions and their rounding boundaries", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "/tmp/blot-pure-float-format.blot";
    await compiler.checkSource(
      path,
      `const Float = import "blot:float"
return { .f64 = Float.F64.to_text; .f32 = Float.F32.to_text; }
`,
    );
    const artifact = await compiler.compile(path);
    const guest = await instantiateArtifact(artifact);
    try {
      for (
        const [value, expected] of [
          [0, "0"],
          [-0, "-0"],
          [0.1, "0.1"],
          [1e-6, "0.000001"],
          [1e-7, "1e-7"],
          [1e20, "100000000000000000000"],
          [1e21, "1e+21"],
          [Number.MIN_VALUE, "5e-324"],
          [Number.MAX_VALUE, "1.7976931348623157e+308"],
          [2 ** -1022, "2.2250738585072014e-308"],
          [NaN, "nan"],
          [Infinity, "inf"],
          [-Infinity, "-inf"],
        ] as const
      ) assert.equal(guest.call("f64", [value]), expected);
      for (
        const [value, expected] of [
          [0, "0"],
          [-0, "-0"],
          [Math.fround(0.1), "0.1"],
          [2 ** -149, "1e-45"],
          [2 ** -126, "1.1754944e-38"],
          [Math.fround(3.4028234663852886e38), "3.4028235e+38"],
          [NaN, "nan"],
          [Infinity, "inf"],
          [-Infinity, "-inf"],
        ] as const
      ) assert.equal(guest.call("f32", [value]), expected);

      const bits = new DataView(new ArrayBuffer(8));
      for (
        const value of [
          ...[-1074, -1022, -1021, -100, -1, 0, 1, 52, 53, 100, 1023].map((
            exponent,
          ) => 2 ** exponent),
          ...[-323, -308, -7, -6, -1, 0, 1, 20, 21, 23, 308].map((exponent) =>
            10 ** exponent
          ),
        ]
      ) {
        bits.setFloat64(0, value, true);
        const center = bits.getBigUint64(0, true);
        for (const offset of [-1n, 0n, 1n]) {
          bits.setBigUint64(0, center + offset, true);
          const neighbor = bits.getFloat64(0, true);
          assert.equal(
            guest.call("f64", [neighbor]),
            String(neighbor),
            `binary64 boundary ${neighbor}`,
          );
        }
      }
      for (
        const exponent of [-149, -126, -125, -24, -1, 0, 1, 23, 24, 100, 127]
      ) {
        bits.setFloat32(0, 2 ** exponent, true);
        const center = bits.getUint32(0, true);
        for (const offset of [-1, 0, 1]) {
          bits.setUint32(0, center + offset, true);
          const neighbor = bits.getFloat32(0, true);
          const text = String(guest.call("f32", [neighbor]));
          assert(
            Object.is(Math.fround(Number(text)), neighbor),
            `binary32 boundary ${neighbor}`,
          );
          if (neighbor !== 0) {
            assert.equal(
              significantDigits(text),
              shortestBinary32Digits(neighbor),
            );
          }
        }
      }
      let seed = 123456789n;
      for (let index = 0; index < 512; index += 1) {
        seed = BigInt.asUintN(
          64,
          seed * 6364136223846793005n + 1442695040888963407n,
        );
        bits.setBigUint64(0, seed, true);
        const binary64 = bits.getFloat64(0, true);
        if (Number.isFinite(binary64) && binary64 !== 0) {
          const text = guest.call("f64", [binary64]);
          assert.equal(
            text,
            String(binary64),
            `binary64 bits ${seed.toString(16)}`,
          );
          assert(Object.is(Number(text), binary64));
        }
        const binary32 = bits.getFloat32(0, true);
        if (Number.isFinite(binary32) && binary32 !== 0) {
          const text = guest.call("f32", [binary32]);
          assert.equal(typeof text, "string");
          assert(Object.is(Math.fround(Number(text)), binary32));
          assert.equal(
            significantDigits(String(text)),
            shortestBinary32Digits(binary32),
          );
        }
      }
    } finally {
      await guest.close();
    }
    const pathExample = "examples/float_formatting.blot";
    const evaluated = await compiler.evaluate(pathExample);
    const emitted = await observeArtifact(await compiler.compile(pathExample));
    assert.deepEqual(
      emitted.value,
      evaluationObservation(evaluated.value, emitted.type),
    );
    assert.deepEqual(emitted.value, ["-0", "0.1", "0.1", "5e-324"]);
  } finally {
    compiler.destroy();
  }
});
