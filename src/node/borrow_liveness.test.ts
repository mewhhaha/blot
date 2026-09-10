import assert from "node:assert/strict";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";

const prelude = `open import "blot:prelude"
const Device = @effect.host {
  .read = Effect.suspends (Int -> Int);
  .inspect = Int -> Int;
}
`;

test("last-use borrow suspension agrees in the evaluator and emitted Wasm", async () => {
  const compiler = await Compiler.create();
  const program = `open import "blot:prelude"
const Device = @effect.host { .read = Effect.suspends (Int -> Int); }
const run :: [Int] -> Int ~ { Device }
const run = fn &values => do:
  let length = Array.length (&values)
  use answer <- Device.read length
  return length + answer
`;
  try {
    const oraclePath = "/tmp/borrow-end-evaluator.blot";
    await compiler.checkSource(
      oraclePath,
      program + `const respond = {
  .read = fn (length, ?resume) => resume (length + 36);
  .return = identity;
}
return @handle (Device, fn () => run [1, 2, 3], respond)
`,
    );
    const evaluated = await compiler.evaluate(oraclePath);
    assert.equal(evaluated.display, "42");
    const guestPath = "/tmp/borrow-end-wasm.blot";
    await compiler.checkSource(guestPath, program + "return { .run = run; }\n");
    const observed: bigint[] = [];
    const read: HostOperation = async (_context, length) => {
      if (typeof length !== "bigint") {
        throw new TypeError("expected array length");
      }
      observed.push(length);
      await Promise.resolve();
      return length + 36n;
    };
    const hosted = await instantiateArtifact(
      await compiler.compile(guestPath),
      new Map([["Device", new Map([["read", read]])]]),
    );
    try {
      const result = await hosted.callAsync("run", [[1n, 2n, 3n]]);
      assert.equal(result, 42n);
      assert.equal(String(result), evaluated.display);
      assert.deepEqual(observed, [3n]);
    } finally {
      await hosted.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("borrows end after their last demanded expression", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const [name, source] of [
        [
          "direct",
          `const run = fn &values => do:
  let length = Array.length (&values)
  use answer <- Device.read length
  return length + answer
return { .run = run; }
`,
        ],
        [
          "transitive",
          `const read = fn value => do:
  use answer <- Device.read value
  return answer
const run = fn &values => do:
  let length = Array.length (&values)
  use answer <- read length
  return answer
return { .run = run; }
`,
        ],
        [
          "open-row",
          `const run = fn read => fn &values => do:
  let length = Array.length (&values)
  use answer <- read length
  return answer
return { .run = run; }
`,
        ],
        [
          "undemanded-read",
          `const run = fn &values => do:
  use answer <- Device.read 1
  let ignored = Array.length (&values)
  return answer
return { .run = run; }
`,
        ],
        [
          "loop-after-last-use",
          `const run = fn &values => do:
  let total = Array.length (&values)
  for index in Iter.range (0, 3):
    use next <- Device.read index
    total := total + next
  return total
return { .run = run; }
`,
        ],
      ]
    ) {
      await compiler.checkSource(
        `/tmp/borrow-end-${name}.blot`,
        prelude + source,
      );
    }
  } finally {
    compiler.destroy();
  }
});

test("borrow endpoints follow branch continuations and lexical identities", async () => {
  const compiler = await Compiler.create();
  try {
    await compiler.checkSource(
      "/tmp/borrow-end-branches.blot",
      prelude + `const run = fn &values => fn condition => do:
  if condition:
    return Array.length (&values)
  use answer <- Device.read 1
  return answer
return { .run = run; }
`,
    );
    await compiler.checkSource(
      "/tmp/borrow-end-shadow.blot",
      prelude + `const run = fn &values => do:
  use inner <- do:
    let values = [1, 2]
    use answer <- Device.read 1
    return Array.length (&values) + answer
  return inner
return { .run = run; }
`,
    );
    await assert.rejects(
      compiler.checkSource(
        "/tmp/borrow-live-join.blot",
        prelude + `const run = fn &values => fn condition => do:
  let answer = 0
  if condition:
    use next <- Device.read 1
    answer := next
  return Array.length (&values) + answer
return { .run = run; }
`,
      ),
      /BLOT_BORROW_ACROSS_SUSPENSION/,
    );
    await assert.rejects(
      compiler.checkSource(
        "/tmp/borrow-live-outer-shadow.blot",
        prelude + `const run = fn &values => do:
  use inner <- do:
    let values = [1, 2]
    use answer <- Device.read 1
    return Array.length (&values) + answer
  return Array.length (&values) + inner
return { .run = run; }
`,
      ),
      /BLOT_BORROW_ACROSS_SUSPENSION/,
    );
  } finally {
    compiler.destroy();
  }
});

test("future aliases and captured borrows remain live across suspension", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const [name, source] of [
        [
          "alias",
          `const run = fn &values => do:
  let alias = &values
  use answer <- Device.read 1
  return Array.length (&alias) + answer
return { .run = run; }
`,
        ],
        [
          "closure",
          `const run = fn &values => do:
  let read = fn () => Array.length (&values)
  use answer <- Device.read 1
  return read () + answer
return { .run = run; }
`,
        ],
        [
          "late-capture",
          `const run = fn &values => fn () => do:
  use answer <- Device.read 1
  return Array.length (&values) + answer
return { .run = run; }
`,
        ],
        [
          "recursive-capture",
          `const run = fn &values => do:
  let rec again = fn count => do:
    let length = Array.length (&values)
    use next <- Device.read length
    return again next
  return again 0
return { .run = run; }
`,
        ],
        [
          "loop-capture",
          `const run = fn &values => do:
  let total = 0
  for index in Iter.range (0, 3):
    let length = Array.length (&values)
    use next <- Device.read length
    total := total + next
  return total
return { .run = run; }
`,
        ],
      ]
    ) {
      await assert.rejects(
        compiler.checkSource(`/tmp/borrow-live-${name}.blot`, prelude + source),
        /BLOT_BORROW_(ACROSS_SUSPENSION|STORED|RESULT_ESCAPES|MOVED)/,
      );
    }
  } finally {
    compiler.destroy();
  }
});

test("borrowed operands stay live while later arguments suspend", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      compiler.checkSource(
        "/tmp/borrow-held-operand.blot",
        prelude +
          `const inspect = fn (&values, answer) => Array.length (&values) + answer
const run = fn ?values => inspect (&values, Device.read 1)
return { .run = run; }
`,
      ),
      /BLOT_BORROW_ACROSS_SUSPENSION/,
    );
    await compiler.checkSource(
      "/tmp/borrow-live-synchronous-operation.blot",
      prelude + `const run = fn &values => do:
  use answer <- Device.inspect 1
  return Array.length (&values) + answer
return { .run = run; }
`,
    );
    await assert.rejects(
      compiler.checkSource(
        "/tmp/borrow-live-open-row.blot",
        `open import "blot:prelude"
const run = fn read => fn &values => do:
  use answer <- read 1
  return Array.length (&values) + answer
return { .run = run; }
`,
      ),
      /BLOT_BORROW_ACROSS_SUSPENSION/,
    );
  } finally {
    compiler.destroy();
  }
});
