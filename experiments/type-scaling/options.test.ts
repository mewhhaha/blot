import assert from "node:assert/strict";
import test from "node:test";
import { parseScalingOptions } from "./options.ts";

const families = ["ordinary", "union", "refinement"] as const;

test("scaling defaults and explicit options preserve caller inputs", () => {
  assert.deepEqual(parseScalingOptions([], families), {
    samples: 3,
    sizes: [8, 16, 32, 64, 128, 256],
    families: [...families],
  });
  const args = Object.freeze(["--", "union", "--sizes=3,9", "--samples=5"]);
  assert.deepEqual(parseScalingOptions(args, families), {
    samples: 5,
    sizes: [3, 9],
    families: ["union"],
  });
  assert.deepEqual(args, ["--", "union", "--sizes=3,9", "--samples=5"]);
});

test("one size remains a supported measurement without a slope", () => {
  assert.deepEqual(parseScalingOptions(["--sizes=16"], families).sizes, [16]);
});

for (const value of ["3junk", "3.5", "3e2", "+3", " 3", "", "0", "-3"]) {
  test(`scaling rejects non-positive or partial integer ${JSON.stringify(value)}`, () => {
    assert.throws(
      () => parseScalingOptions([`--samples=${value}`], families),
      /positive decimal integers/,
    );
    assert.throws(
      () => parseScalingOptions([`--sizes=1,${value}`], families),
      /positive decimal integers/,
    );
  });
}

test("scaling rejects unsafe integers and even sample counts", () => {
  assert.throws(
    () => parseScalingOptions(["--samples=9007199254740993"], families),
    /positive decimal integers/,
  );
  assert.throws(
    () => parseScalingOptions(["--sizes=1,9007199254740993"], families),
    /positive decimal integers/,
  );
  assert.throws(
    () => parseScalingOptions(["--samples=2"], families),
    /positive odd integer/,
  );
});

test("scaling rejects duplicate and descending sizes rather than corrupting slopes", () => {
  for (const sizes of ["8,8", "16,8", "8,32,16"]) {
    assert.throws(
      () => parseScalingOptions([`--sizes=${sizes}`], families),
      /strictly increasing/,
    );
  }
});

test("scaling family names cannot resolve through Object.prototype", () => {
  for (const family of ["constructor", "toString", "__proto__", "missing"]) {
    assert.throws(
      () => parseScalingOptions([family], families),
      /unknown type-scaling family/,
    );
  }
});

test("scaling rejects repeated flags and repeated families", () => {
  for (const args of [
    ["--samples=3", "--samples=5"],
    ["--sizes=8", "--sizes=16"],
    ["union", "union"],
  ]) {
    assert.throws(() => parseScalingOptions(args, families), /duplicate/);
  }
});
