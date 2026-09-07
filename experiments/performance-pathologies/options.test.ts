import assert from "node:assert/strict";
import test from "node:test";
import { MAX_VALUES, parseOptions } from "./options.ts";

test("benchmark defaults are unchanged and independently owned", () => {
  const expected = {
    depths: [4, 6, 8, 10],
    sizes: [4096, 8192, 16384, 32768],
    samples: 3,
  };
  const options = parseOptions([]);
  assert.deepEqual(options, expected);
  options.depths.push(1);
  assert.deepEqual(parseOptions([]), expected);
});

test("benchmark options accept decimal boundaries and one leading separator", () => {
  const input = ["--", "--sizes=1,131072", "--samples=101", "--depths=1,64"];
  assert.deepEqual(parseOptions(input), {
    depths: [1, 64],
    sizes: [1, 131072],
    samples: 101,
  });
  assert.equal(input[0], "--");
  assert.equal(
    parseOptions([`--depths=${Array(MAX_VALUES).fill(1).join(",")}`]).depths
      .length,
    MAX_VALUES,
  );
});

for (
  const argument of [
    "--depths=0",
    "--depths=65",
    "--sizes=131073",
    "--samples=102",
    "--sizes=9007199254740992",
    "--depths=-1",
    "--depths=1.5",
    "--depths=1e1",
    "--depths=0x10",
    "--depths=+1",
    "--depths=01",
    "--depths=Infinity",
    "--depths=NaN",
    "--depths=",
    "--depths= ",
    "--depths=1,",
    "--depths=,1",
    "--depths=1,,2",
    "--depths=1, 2",
    "--samples=1,2",
    "--other=1",
    "--depths",
    "4",
    "--depths=1=2",
    `--sizes=${Array(MAX_VALUES + 1).fill(1).join(",")}`,
  ]
) {
  test(`benchmark refuses malformed or unbounded option ${argument}`, () => {
    assert.throws(() => parseOptions([argument]));
  });
}

for (const name of ["depths", "sizes", "samples"]) {
  test(`benchmark refuses duplicate --${name} instead of ignoring later values`, () => {
    assert.throws(
      () => parseOptions([`--${name}=1`, `--${name}=2`]),
      /duplicate/,
    );
  });
}

test("only the first argument can be a separator", () => {
  assert.throws(() => parseOptions(["--", "--"]), /unknown/);
  assert.throws(() => parseOptions(["--depths=1", "--"]), /unknown/);
});
