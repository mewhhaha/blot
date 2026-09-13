import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { RuntimeValue } from "../abi_values.ts";
import { Compiler } from "../compiler.ts";
import { type HostOperation, instantiateArtifact } from "../host.ts";
import { evaluationObservation } from "../runtime_observation.ts";
import { observeArtifact } from "./run.ts";

test("inferred recursive sums preserve tail calls and evaluator/Wasm agreement", async () => {
  const compiler = await Compiler.create();
  try {
    const guest = await instantiateArtifact(
      await compiler.compile("examples/lib/inferred_search.blot"),
    );
    try {
      const values = Array<bigint>(100_000).fill(0n);
      assert.deepEqual(guest.call("run", [values]), {
        kind: "variant",
        name: "None",
      });
      values.push(3n);
      assert.deepEqual(guest.call("run", [values]), {
        kind: "variant",
        name: "Some",
        payload: 3n,
      });
      assert.deepEqual(guest.call("text", [["a", "é", "😀😀😀"]]), {
        kind: "variant",
        name: "Some",
        payload: "😀😀😀",
      });
    } finally {
      await guest.close();
    }
    for (
      const path of [
        "examples/inferred_search.blot",
        "examples/effectful_iterator.blot",
      ]
    ) {
      const evaluated = await compiler.evaluate(path);
      const emitted = await observeArtifact(await compiler.compile(path));
      assert.deepEqual(
        emitted.value,
        evaluationObservation(evaluated.value, emitted.type),
        path,
      );
    }
    const mixed = "/tmp/blot-untagged-union.blot";
    await compiler.checkSource(
      mixed,
      `open import "blot:prelude"
const choose = fn (flag :: Bool, integer :: Int, float :: F64) => case flag of
  #True => integer
  #False => float
return { .choose; }
`,
    );
    await assert.rejects(
      compiler.compile(mixed),
      { name: "CompilerTargetRefusal", message: /incompatible runtime types/ },
    );
  } finally {
    compiler.destroy();
  }
});

test("effectful iterator steps sequence around pure bodies, exits, nesting, and cancellation", async () => {
  const compiler = await Compiler.create();
  try {
    const trace: bigint[] = [];
    let startSuspension: (() => void) | undefined;
    let drained = false;
    const visit: HostOperation = ({ signal }, value) => {
      assert.equal(typeof value, "bigint");
      trace.push(BigInt(String(value)));
      if (startSuspension === undefined) return Promise.resolve(value);
      startSuspension();
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          queueMicrotask(() => {
            drained = true;
            reject(signal.reason);
          });
        }, { once: true })
      );
    };
    const guest = await instantiateArtifact(
      await compiler.compile("examples/lib/effectful_iterator.blot"),
      new Map([["Visit", new Map([["value", visit]])]]),
    );
    try {
      for (
        const [name, limit, expected, visits] of [
          ["run", 4n, 6n, [0n, 1n, 2n, 3n]],
          ["run", 0n, 0n, []],
          ["first", 100n, 0n, [0n]],
          ["first", 0n, -1n, []],
          ["limited", 100n, 4n, [0n, 1n, 2n, 3n]],
          ["nested", 3n, 63n, [0n, 1n, 10n, 11n, 20n, 21n]],
          ["body_return", 100n, 1n, [1n]],
          ["body_return", 0n, -1n, []],
        ] as const
      ) {
        trace.length = 0;
        assert.equal(await guest.callAsync(name, [limit]), expected, name);
        assert.deepEqual(trace, visits, name);
      }
      trace.length = 0;
      const entered = new Promise<void>((resolve) => {
        startSuspension = resolve;
      });
      const controller = new AbortController();
      const reason = new Error("stop iterator traversal");
      const pending = guest.callAsync("run", [100n], {
        signal: controller.signal,
      });
      const rejected = assert.rejects(pending, (error) => error === reason);
      await entered;
      controller.abort(reason);
      await rejected;
      assert.equal(drained, true);
      assert.deepEqual(trace, [0n]);
    } finally {
      await guest.close();
    }
  } finally {
    compiler.destroy();
  }
});

test("loop returns preserve scalar and record payload representations", async () => {
  const compiler = await Compiler.create();
  const tuple = (...elements: RuntimeValue[]): RuntimeValue => ({
    kind: "record",
    fields: new Map(elements.map((value, index) => [String(index), value])),
  });
  try {
    const path = "/tmp/blot-loop-return-values.blot";
    await compiler.checkSource(
      path,
      `open import "blot:prelude"
const compare = fn (limit :: Int, y :: Int) -> Int => do:
  for x in Iter.range (0, limit):
    if x < y:
      return -1
    if x > y:
      return 1
  return 0
return { .compare; }
`,
    );
    const comparison = await instantiateArtifact(await compiler.compile(path));
    try {
      assert.equal(comparison.call("compare", [tuple(0n, 0n)]), 0n);
      assert.equal(comparison.call("compare", [tuple(2n, 0n)]), 1n);
      assert.equal(comparison.call("compare", [tuple(2n, 1n)]), -1n);
    } finally {
      await comparison.close();
    }
    const traversal = await instantiateArtifact(
      await compiler.compile("examples/lib/float_sweep.blot"),
    );
    const point = (coordinates: { x: number; y: number }): RuntimeValue => ({
      kind: "record",
      fields: new Map(Object.entries(coordinates)),
    });
    try {
      for (
        const [position, displacement, expected] of [
          [{ x: 0, y: 0 }, { x: 1, y: 0 }, {
            position: { x: 1, y: 0 },
            speaker: -1n,
          }],
          [{ x: 3, y: 0 }, { x: 1, y: 0 }, {
            position: { x: 3, y: 0 },
            speaker: -1n,
          }],
          [{ x: 0, y: 3 }, { x: 0, y: 0 }, {
            position: { x: 0, y: 3 },
            speaker: 1n,
          }],
        ] as const
      ) {
        assert.deepEqual(
          traversal.call("sweep", [
            tuple(point(position), point(displacement)),
          ]),
          {
            kind: "record",
            fields: new Map<string, RuntimeValue>([
              ["position", point(expected.position)],
              ["speaker", expected.speaker],
            ]),
          },
        );
      }
    } finally {
      await traversal.close();
    }
    const observed = "/tmp/blot-loop-return-observation.blot";
    await compiler.checkSource(
      observed,
      `open import "blot:prelude"
const traversal = import "${resolve("examples/lib/float_sweep.blot")}"
return traversal.sweep ({ .x = 0.0; .y = 0.0; }, { .x = 1.0; .y = 0.0; })
`,
    );
    const evaluated = await compiler.evaluate(observed);
    const emitted = await observeArtifact(await compiler.compile(observed));
    assert.deepEqual(
      emitted.value,
      evaluationObservation(evaluated.value, emitted.type),
    );
  } finally {
    compiler.destroy();
  }
});

test("nested case payloads retain their principal input/output relationship", async () => {
  const compiler = await Compiler.create();
  try {
    const prefix = `open import "blot:prelude"
const unwrap = fn wrapped => case wrapped of
  #Wrap { .value = value; } => value
`;
    const path = "/tmp/blot-nested-payload.blot";
    const checked = await compiler.checkSource(
      path,
      `${prefix}return (
  unwrap (#Wrap { .value = 42; }),
  unwrap (#Wrap { .value = "text"; })
)
`,
    );
    assert.equal(checked.type, '{ .0 = 42; .1 = "text" }');
    const evaluated = await compiler.evaluate(path);
    const emitted = await observeArtifact(await compiler.compile(path));
    assert.deepEqual(
      emitted.value,
      evaluationObservation(evaluated.value, emitted.type),
    );
    await assert.rejects(
      compiler.checkSource(
        "/tmp/blot-nested-payload-mismatch.blot",
        `${prefix}const result :: Int
const result = unwrap (#Wrap { .value = "wrong"; })
return result
`,
      ),
      /BLOT_TYPE_ERROR/,
    );
  } finally {
    compiler.destroy();
  }
});

test("rebinding requires explicit sequencing for effects", async () => {
  const compiler = await Compiler.create();
  try {
    const prefix = `open import "blot:prelude"
const Read = @effect { .value = Int -> Int; }
`;
    await assert.rejects(
      compiler.checkSource(
        "/tmp/blot-effectful-rebinding.blot",
        `${prefix}const run = fn value => do:
  let result = 0
  result := Read.value value
  return result
return 0
`,
      ),
      /BLOT_UNSEQUENCED_EFFECT/,
    );
    const path = "/tmp/blot-sequenced-rebinding.blot";
    await compiler.checkSource(
      path,
      `${prefix}const run = fn value => do:
  let result = 0
  use next <- Read.value value
  result := next
  return result
return @handle (Read, fn () => run 1, {
  .value = fn (value, ?resume) => resume (value + 41)
})
`,
    );
    const evaluated = await compiler.evaluate(path);
    assert.equal(evaluated.display, "42");
    const emitted = await observeArtifact(await compiler.compile(path));
    assert.deepEqual(
      emitted.value,
      evaluationObservation(evaluated.value, emitted.type),
    );
  } finally {
    compiler.destroy();
  }
});
