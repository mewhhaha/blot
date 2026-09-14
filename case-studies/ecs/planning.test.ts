import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeValue } from "../../src/abi_values.ts";
import { Compiler } from "../../src/compiler.ts";
import { BlotError } from "../../src/diagnostic.ts";
import { instantiateArtifact } from "../../src/host.ts";
import { observeArtifact } from "../../src/node/run.ts";
import { evaluationObservation } from "../../src/runtime_observation.ts";
import { inspectKernel } from "./verification.ts";

function record(fields: Record<string, RuntimeValue>): RuntimeValue {
  return { kind: "record", fields: new Map(Object.entries(fields)) };
}

function tuple(...values: RuntimeValue[]): RuntimeValue {
  return record(
    Object.fromEntries(values.map((value, index) => [String(index), value])),
  );
}

function systems(names: string[]): RuntimeValue {
  return { kind: "variant", name: "Systems", payload: names };
}

function barrier(name: string): RuntimeValue {
  return { kind: "variant", name: "Barrier", payload: name };
}

interface Entity {
  readonly Position: bigint;
  readonly Velocity: bigint;
  readonly Age: bigint;
  readonly Distance: bigint;
  readonly Label: string;
}

function tick(row: Entity): Entity {
  const position = row.Position + row.Velocity;
  let velocity = row.Velocity;
  if (position >= 10n) velocity = -velocity;
  let distance = position;
  if (distance < 0n) distance = -distance;
  return {
    Position: position,
    Velocity: velocity,
    Age: row.Age + 1n,
    Distance: distance,
    Label: String(position),
  };
}

test("access plans preserve rows across fused work, barriers, and repeated ticks", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "case-studies/ecs/planned-runtime.test.blot";
    await compiler.checkSource(
      path,
      `
const s = import "./scheduling.blot"
return { .tick = s.tick; .fused = s.fused; .old_label = s.old_label; .unchanged = s.unchanged; }
`,
    );
    const guest = await instantiateArtifact(await compiler.compile(path));
    try {
      for (const length of [0, 1, 17, 129]) {
        const initial = Array.from({ length }, (_, index): Entity => ({
          Position: BigInt(index - 6),
          Velocity: BigInt(index % 7 - 3),
          Age: BigInt(index),
          Distance: 999n,
          Label: `entity ${index} — 🐈`,
        }));
        const encoded = initial.map((row) => record({ ...row }));
        assert.deepEqual(guest.call("unchanged", [encoded]), encoded);
        for (const name of ["tick", "fused"]) {
          let expected = initial;
          let actual = encoded;
          for (let frame = 0; frame < 4; frame += 1) {
            expected = expected.map(tick);
            const result = guest.call(name, [actual]);
            assert.deepEqual(
              result,
              expected.map((row) => record({ ...row })),
              `${name}: ${length} rows, frame ${frame}`,
            );
            assert.ok(Array.isArray(result));
            actual = result;
          }
        }
        assert.deepEqual(
          guest.call("old_label", [encoded]),
          initial.map((row) => {
            const moved = tick(row);
            return record({
              ...row,
              Position: moved.Position,
              Velocity: moved.Velocity,
              Label: String(row.Position),
            });
          }),
        );
      }
    } finally {
      guest.destroy();
    }
    const example = "case-studies/ecs/schedule-plan.blot";
    const evaluated = await compiler.evaluate(example);
    const emitted = await observeArtifact(await compiler.compile(example));
    assert.deepEqual(
      evaluationObservation(evaluated.value, {
        kind: "record",
        fields: [{ name: "default", type: emitted.type }],
      }),
      record({ default: emitted.value }),
    );
    assert.deepEqual(evaluated.writes, []);
  } finally {
    compiler.destroy();
  }
});

test("read/write conflict analysis agrees with set intersections", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "case-studies/ecs/conflicts.test.blot";
    await compiler.checkSource(
      path,
      `
const P = import "./planning.blot"
return { .conflicts = P.conflicts; .compatible = P.compatible; }
`,
    );
    const guest = await instantiateArtifact(await compiler.compile(path));
    try {
      const accesses = Array.from({ length: 16 }, (_, mask) => ({
        reads: ["Position", "Velocity"].filter((_, index) =>
          (mask & (1 << index)) !== 0
        ),
        writes: ["Position", "Velocity"].filter((_, index) =>
          (mask & (1 << (index + 2))) !== 0
        ),
      }));
      for (const left of accesses) {
        for (const right of accesses) {
          const overlap = {
            write_read: left.writes.filter((name) =>
              right.reads.includes(name)
            ),
            read_write: left.reads.filter((name) =>
              right.writes.includes(name)
            ),
            write_write: left.writes.filter((name) =>
              right.writes.includes(name)
            ),
          };
          const args = [tuple(record(left), record(right))];
          assert.deepEqual(guest.call("conflicts", args), record(overlap));
          assert.equal(
            guest.call("compatible", args),
            Object.values(overlap).every((names) => names.length === 0),
          );
        }
      }
    } finally {
      guest.destroy();
    }
  } finally {
    compiler.destroy();
  }
});

test("graphs merge stable identities and sort dependencies into compatible batches", async () => {
  const compiler = await Compiler.create();
  try {
    const cases: [string, RuntimeValue[], string[][]][] = [
      ["s.graph", [
        systems(["integrate", "age"]),
        systems(["bounce"]),
        barrier("publish"),
        systems(["distance", "label"]),
      ], [["integrate", "age", "bounce"], ["distance", "label"]]],
      ['P.group ["distance", "label"]', [systems(["distance", "label"])], [[
        "distance",
        "label",
      ]]],
      ['P.group ["label", "integrate"]', [
        systems(["label"]),
        systems(["integrate"]),
      ], [["label", "integrate"]]],
      ['P.group ["integrate", "label"]', [
        systems(["integrate"]),
        systems(["label"]),
      ], [["integrate", "label"]]],
      [
        'P.merge (P.group ["label", "integrate"], P.before ("integrate", "label"))',
        [systems(["integrate"]), systems(["label"])],
        [["integrate", "label"]],
      ],
      ["P.merge (s.graph, s.graph)", [
        systems(["integrate", "age"]),
        systems(["bounce"]),
        barrier("publish"),
        systems(["distance", "label"]),
      ], [["integrate", "age", "bounce"], ["distance", "label"]]],
      ["P.merge (P.merge (s.physics, s.bookkeeping), s.observers)", [
        systems(["integrate", "age"]),
        systems(["bounce", "distance", "label"]),
      ], [["integrate", "age", "bounce", "distance", "label"]]],
      ["P.merge (s.physics, P.merge (s.bookkeeping, s.observers))", [
        systems(["integrate", "age"]),
        systems(["bounce", "distance", "label"]),
      ], [["integrate", "age", "bounce", "distance", "label"]]],
      [
        'P.then (P.then (P.barrier "start", P.barrier "publish"), P.group ["age"])',
        [barrier("start"), barrier("publish"), systems(["age"])],
        [["age"]],
      ],
      ["P.group []", [], []],
    ];
    for (const [graph, batches, passes] of cases) {
      const path = "case-studies/ecs/graph.test.blot";
      await compiler.checkSource(
        path,
        `
const P = import "./planning.blot"
const s = import "./scheduling.blot"
const report :: P.Report
const report = P.analyze (s.registry, ${graph})
return { .default = report; }
`,
      );
      try {
        const emitted = await observeArtifact(await compiler.compile(path));
        assert.deepEqual(
          emitted.value,
          record({ batches, order: passes.flat(), passes }),
          graph,
        );
      } catch (error) {
        throw new Error(graph, { cause: error });
      }
    }
  } finally {
    compiler.destroy();
  }
});

test("planning erases metadata and emits one traversal per nonempty barrier phase", async () => {
  const compiler = await Compiler.create();
  try {
    const rowType =
      "{ .Position = Int; .Velocity = Int; .Age = Int; .Distance = Int; .Label = Text }";
    for (
      const [kernel, traversals] of [["planned", 1], ["barrier", 2], [
        "empty-plan",
        0,
      ]] as const
    ) {
      assert.deepEqual(
        await compiler.check(`case-studies/ecs/kernels/${kernel}.blot`),
        {
          type: `[${rowType}] -> [${rowType}]`,
          effects: "",
        },
      );
      assert.equal(
        (await inspectKernel(compiler, kernel)).outputStores,
        traversals,
      );
      const hir = await compiler.prepare(
        `case-studies/ecs/kernels/${kernel}.blot`,
      );
      for (const fn of hir.functions) {
        for (const block of fn.continuations) {
          for (const { operation } of block.instructions) {
            if (operation.kind === "constant") {
              assert.ok(
                ![
                  "Distance",
                  "integrate",
                  "bounce",
                  "age",
                  "distance",
                  "label",
                  "publish",
                ].includes(String(operation.value)),
              );
            }
          }
        }
      }
    }
  } finally {
    compiler.destroy();
  }
});

test("generated system views restrict reads and apply a simultaneous typed patch", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "case-studies/ecs/capabilities.test.blot";
    await compiler.checkSource(
      path,
      `
open import "blot:prelude"
const Systems = import "./systems.blot"
const ECS = import "./ecs.blot"
const Entity = ECS.archetype { .Position = Int; .Velocity = Int; .Age = Int; }
const S = Systems Entity
const C = Entity.components
const reset = S.define ({ .reads = []; .writes = [C.Position]; }, fn read => { .Position = 0; })
const noop = S.define ({ .reads = []; .writes = []; }, fn read => {})
const swap = S.define ({ .reads = [C.Position, C.Velocity]; .writes = [C.Position, C.Velocity]; }, fn read => { .Position = read.Velocity; .Velocity = read.Position; })
const duplicate = S.define ({ .reads = [C.Position, C.Position]; .writes = [C.Position, C.Position]; }, fn read => { .Position = read.Position + 1; })
const reflective = S.define ({ .reads = [C.Position]; .writes = [C.Position]; }, fn read => { .Position = @shape.get read (case @shape.has read "Age" of
  #True => "Age"
  #False => "Position"
); })
const reset_row :: Entity -> Entity
const reset_row = reset.step
const unchanged :: Entity -> Entity
const unchanged = noop.step
const swap_row :: Entity -> Entity
const swap_row = swap.step
const increment :: Entity -> Entity
const increment = duplicate.step
const reflect_row :: Entity -> Entity
const reflect_row = reflective.step
return { .reset = reset_row; .unchanged; .swap = swap_row; .increment; .reflect = reflect_row; .reads = duplicate.reads; .writes = duplicate.writes; }
`,
    );
    const guest = await instantiateArtifact(await compiler.compile(path));
    try {
      const row = { Position: 3n, Velocity: 7n, Age: 90n };
      const args = [record(row)];
      assert.deepEqual(
        guest.call("reset", args),
        record({ ...row, Position: 0n }),
      );
      assert.deepEqual(guest.call("unchanged", args), record(row));
      assert.deepEqual(
        guest.call("swap", args),
        record({ ...row, Position: 7n, Velocity: 3n }),
      );
      assert.deepEqual(
        guest.call("increment", args),
        record({ ...row, Position: 4n }),
      );
      assert.deepEqual(guest.call("reflect", args), record(row));
      assert.deepEqual(guest.call("reads", []), ["Position"]);
      assert.deepEqual(guest.call("writes", []), ["Position"]);
    } finally {
      guest.destroy();
    }
  } finally {
    compiler.destroy();
  }
});

test("systems reject undeclared reads, invalid patches, and host effects at checking", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const [source, code] of [
        [
          'const unused = S.define ({ ...access; .reads = ["Position"]; }, fn read => { .Position = 1; })',
          "BLOT_NO_FIELD",
        ],
        [
          "const unused = S.define ({ ...access; .reads = [C.Missing]; }, fn read => { .Position = 1; })",
          "BLOT_NO_FIELD",
        ],
        [
          "const unused = S.define ({ ...access; .reads = [Other.Position]; }, fn read => { .Position = 1; })",
          "BLOT_REFUSED",
        ],
        [
          "const unused = S.define ({ ...access; .writes = [Other.Position]; }, fn read => { .Position = 1; })",
          "BLOT_REFUSED",
        ],
        [
          "const unused = S.define (access, fn read => { .Position = read.Velocity; })",
          "BLOT_TYPE_ERROR",
        ],
        [
          'const unused = S.define (access, fn read => { .Position = "wrong"; })',
          "BLOT_TYPE_ERROR",
        ],
        [
          "const unused = S.define (access, fn read => { .Age = 1; })",
          "BLOT_TYPE_ERROR",
        ],
        [
          "const unused = S.define (access, fn read => { .Position = read.Position; .Age = 1; })",
          "BLOT_DOES_NOT_SATISFY",
        ],
        [
          "const unused = S.define ({ ...access; .reads = [Other.Missing]; }, fn read => { .Position = 1; })",
          "BLOT_REFUSED",
        ],
        [
          "const unused = S.define ({ ...access; .writes = [Other.Missing]; }, fn read => { .Missing = 1; })",
          "BLOT_REFUSED",
        ],
        [
          `const Log = @effect.host { .write = Unit -> Unit; }
const unused = S.define (access, fn read => do:
  use Log.write ()
  return { .Position = read.Position; }
)`,
          "BLOT_TYPE_ERROR",
        ],
      ]
    ) {
      await assert.rejects(
        compiler.checkSource(
          "case-studies/ecs/invalid-system.test.blot",
          `
open import "blot:prelude"
const Systems = import "./systems.blot"
const S = Systems { .Position = Int; .Velocity = Int; .Age = Int; }
const C = S.components
const Other = (Systems { .Position = Text; .Missing = Int; }).components
const access = { .reads = [C.Position]; .writes = [C.Position]; }
${source}
return 0
`,
        ),
        (error: unknown) => {
          assert.ok(error instanceof BlotError, source);
          assert.equal(error.diagnostic.code, code, source);
          assert.ok(error.diagnostic.span.end > error.diagnostic.span.start);
          assert.ok(error.origin);
          assert.ok(error.diagnostic.span.end <= error.origin.source.length);
          return true;
        },
      );
    }
  } finally {
    compiler.destroy();
  }
});

test("invalid schedule graphs report the offending identity", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const [graph, message] of [
        [
          'P.merge (P.before ("integrate", "bounce"), P.before ("bounce", "integrate"))',
          "dependency cycle at: integrate",
        ],
        ['P.before ("age", "age")', "dependency cycle at: age"],
        ['P.group ["missing"]', "unknown scheduled system: missing"],
        [
          '{ .nodes = ["age"]; .edges = [{ .before = "missing"; .after = "age"; }]; .barriers = []; }',
          "dependency source is absent from the schedule: missing",
        ],
        [
          '{ .nodes = ["age"]; .edges = [{ .before = "age"; .after = "missing"; }]; .barriers = []; }',
          "dependency target is absent from the schedule: missing",
        ],
        [
          '{ .nodes = []; .edges = []; .barriers = ["missing"]; }',
          "barrier is absent from the schedule: missing",
        ],
        [
          'P.merge (P.group ["age"], P.barrier "age")',
          "schedule identity is both a system and a barrier: age",
        ],
        ['P.barrier "age"', "schedule barrier has a system definition: age"],
      ]
    ) {
      await assert.rejects(
        compiler.checkSource(
          "case-studies/ecs/invalid-graph.test.blot",
          `
const P = import "./planning.blot"
const s = import "./scheduling.blot"
const plan = P.analyze (s.registry, ${graph})
return plan
`,
        ),
        (error: unknown) => {
          assert.ok(error instanceof BlotError, graph);
          assert.equal(error.diagnostic.code, "BLOT_REFUSED");
          assert.ok(
            error.diagnostic.message.includes(message),
            error.diagnostic.message,
          );
          assert.ok(error.diagnostic.span.end > error.diagnostic.span.start);
          assert.ok(error.origin);
          assert.ok(error.diagnostic.span.end <= error.origin.source.length);
          return true;
        },
      );
    }
  } finally {
    compiler.destroy();
  }
});
