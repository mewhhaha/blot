import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { RuntimeValue } from "../../src/abi_values.ts";
import { Compiler } from "../../src/compiler.ts";
import { BlotError } from "../../src/diagnostic.ts";
import { instantiateArtifact } from "../../src/host.ts";
import { runArtifact } from "../../src/node/run.ts";
import { formatSource } from "../../src/tooling/formatter.ts";
import { inspectKernel } from "./verification.ts";

interface Entity {
  readonly Position: { readonly x: bigint; readonly y: bigint };
  readonly Velocity: { readonly x: bigint; readonly y: bigint };
  readonly Age: bigint;
  readonly Label: string;
}

function tick(row: Entity): Entity {
  const position = {
    x: row.Position.x + row.Velocity.x,
    y: row.Position.y + row.Velocity.y,
  };
  let velocity = row.Velocity;
  if (position.x >= 10n) velocity = { ...velocity, x: -velocity.x };
  return { ...row, Position: position, Velocity: velocity, Age: row.Age + 1n };
}

function record(fields: Record<string, RuntimeValue>): RuntimeValue {
  return { kind: "record", fields: new Map(Object.entries(fields)) };
}

function encode(row: Entity): RuntimeValue {
  return record({
    Position: record(row.Position),
    Velocity: record(row.Velocity),
    Age: row.Age,
    Label: row.Label,
  });
}

test("ECS schedules preserve rows, order, grouping, and both executions", async () => {
  const compiler = await Compiler.create();
  try {
    const rowType =
      "{ .Position = { .x = Int; .y = Int }; .Velocity = { .x = Int; .y = Int }; .Age = Int; .Label = Text }";
    const fields = [`.default = [${rowType}]`];
    for (
      const name of ["fused", "separate", "direct", "regrouped", "wrong_order"]
    ) {
      fields.push(`.${name} = [${rowType}] -> [${rowType}]`);
    }
    const checkedInterface1 = await compiler.check(
      "case-studies/ecs/main.blot",
    );
    assert.deepEqual({
      type: checkedInterface1.type,
      effects: checkedInterface1.effects,
    }, {
      type: `{ ${fields.join("; ")} }`,
      effects: "",
    });
    const guest = await instantiateArtifact(
      await compiler.compile("case-studies/ecs/main.blot"),
    );
    try {
      for (const length of [0, 1, 17, 129]) {
        const initial = Array.from({ length }, (_, index): Entity => ({
          Position: { x: BigInt(index - 6), y: BigInt(index * 2) },
          Velocity: { x: BigInt(index % 7 - 3), y: BigInt(2 - index % 5) },
          Age: BigInt(index),
          Label: `entity ${index} — 🐈`,
        }));
        for (const name of ["fused", "separate", "direct", "regrouped"]) {
          let expected = initial;
          let actual = initial.map(encode);
          for (let frame = 0; frame < 4; frame += 1) {
            expected = expected.map(tick);
            const result = guest.call(name, [actual]);
            assert.deepEqual(
              result,
              expected.map(encode),
              `${name}: ${length} rows, frame ${frame}`,
            );
            assert.ok(Array.isArray(result));
            actual = result;
          }
        }
      }
      const crossing = [encode({
        Position: { x: 8n, y: 0n },
        Velocity: { x: 3n, y: 0n },
        Age: 0n,
        Label: "crossing",
      })];
      assert.notDeepEqual(
        guest.call("fused", [crossing]),
        guest.call("wrong_order", [crossing]),
      );
    } finally {
      guest.destroy();
    }
    for (const count of [0, 1, 3, 17]) {
      const path = "case-studies/ecs/observations.test.blot";
      await compiler.checkSource(
        path,
        `
open import "blot:prelude"
const s = import "./simulation.blot"
let rows = s.seed (${count}, 6)
return (s.checksum (s.fused rows), s.checksum (s.separate rows), s.checksum (s.direct rows), s.checksum (s.regrouped rows))
`,
      );
      let expected = 0n;
      for (let index = 0; index < count; index += 1) {
        const row = tick({
          Position: { x: BigInt(index + 6), y: BigInt(index) },
          Velocity: { x: 3n, y: 2n },
          Age: 0n,
          Label: "particle",
        });
        expected += row.Position.x * 3n + row.Position.y * 5n +
          row.Velocity.x * 7n + row.Velocity.y * 11n + row.Age;
      }
      const display = `(${Array(4).fill(String(expected)).join(", ")})`;
      const evaluated = await compiler.evaluate(path);
      assert.deepEqual(evaluated.writes, []);
      assert.equal(evaluated.display, display);
      assert.equal(
        await runArtifact(await compiler.compile(path)),
        `{ ${
          Array.from({ length: 4 }, (_, index) => `.${index} = ${expected}`)
            .join("; ")
        } }`,
      );
    }
  } finally {
    compiler.destroy();
  }
});

test("merged queries keep same-carrier components distinct and permit repeated reads", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "case-studies/ecs/query.test.blot";
    await compiler.checkSource(
      path,
      `
open import "blot:prelude"
const s = import "./simulation.blot"
const ECS = import "./ecs.blot"
const combined = ECS.Query.merge (s.motion, s.C.Position.get)
let row = { .Position = { .x = 1; .y = 2; }; .Velocity = { .x = 3; .y = 4; }; .Age = 0; .Label = "kept"; }
return s.resolve (row, combined)
`,
    );
    assert.equal(
      (await compiler.evaluate(path)).display,
      "(({ .x = 1; .y = 2; }, { .x = 3; .y = 4; }), { .x = 1; .y = 2; })",
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      "{ .0 = { .0 = { .x = 1; .y = 2 }; .1 = { .x = 3; .y = 4 } }; .1 = { .x = 1; .y = 2 } }",
    );
  } finally {
    compiler.destroy();
  }
});

test("fusing three stages removes two intermediate arrays and erases query machinery", async () => {
  const compiler = await Compiler.create();
  try {
    const fused = await inspectKernel(compiler, "fused");
    const separate = await inspectKernel(compiler, "separate");
    const direct = await inspectKernel(compiler, "direct");
    assert.equal(fused.outputStores, 1);
    assert.equal(separate.outputStores, 3);
    assert.equal(direct.outputStores, 1);
    assert.equal(fused.readSites, direct.readSites);
    assert.ok(fused.readSites < separate.readSites);
  } finally {
    compiler.destroy();
  }
});

for (
  const [name, source, diagnostic] of [
    [
      "wrong component value",
      `return s.C.Position.replace (row, { .x = "wrong"; .y = 0; })`,
      "BLOT_TYPE_ERROR",
    ],
    [
      "missing component",
      `return s.fused [{ .Position = row.Position; .Age = 0; .Label = "missing Velocity"; }]`,
      "BLOT_TYPE_ERROR",
    ],
    [
      "unprovided reader",
      `return s.resolve (row, s.C.Age.get)`,
      "BLOT_UNHANDLED_EFFECT",
    ],
    [
      "shape-changing stage",
      `const bad = fn entity => { .Position = entity.Position; }
const plan = s.Schedule.merge (bad, s.Schedule.empty)
return (s.Schedule.each plan) [row]`,
      "BLOT_TYPE_ERROR",
    ],
    [
      "host effect inside a fused stage",
      `const Log = @effect.host { .write = Unit -> Unit; }
const bad = fn entity => do:
  use Log.write ()
  return entity
const plan = s.Schedule.merge (bad, s.Schedule.empty)
return (s.Schedule.each plan) [row]`,
      "BLOT_TYPE_ERROR",
    ],
  ] as const
) {
  test(`ECS rejects ${name}`, async () => {
    const compiler = await Compiler.create();
    try {
      await assert.rejects(
        () =>
          compiler.checkSource(
            "case-studies/ecs/rejection.test.blot",
            `
open import "blot:prelude"
const s = import "./simulation.blot"
let row = { .Position = { .x = 1; .y = 2; }; .Velocity = { .x = 3; .y = 4; }; .Age = 0; .Label = "kept"; }
${source}
`,
          ),
        (error: unknown) => {
          assert.ok(error instanceof BlotError);
          assert.equal(error.diagnostic.code, diagnostic);
          assert.ok(error.diagnostic.span.end > error.diagnostic.span.start);
          return true;
        },
      );
    } finally {
      compiler.destroy();
    }
  });
}

test("the ECS case study uses canonical Blot formatting", async () => {
  for (
    const name of [
      "ecs",
      "components",
      "constructed-handler",
      "stateful",
      "simulation",
      "main",
      "streams",
      "messages",
      "arena",
      "queries-and-messages",
      "systems",
      "planning",
      "scheduling",
      "schedule-plan",
      "simd/matrix",
      "simd/matrices",
      "simd/transforms",
      "simd/particles",
      "simd/partial-blocks",
      "simd/main",
      "kernels/scalar-matrix",
      "kernels/simd-matrix",
      "kernels/scalar-transforms",
      "kernels/simd-transforms",
      "kernels/scalar-particles",
      "kernels/simd-particles",
      "bench/simd",
      "kernels/planned",
      "kernels/barrier",
      "kernels/empty-plan",
      "kernels/fused",
      "kernels/separate",
      "kernels/direct",
      "bench/fused",
      "bench/separate",
      "bench/direct",
      "bench/setup",
      "bench/boundary",
    ]
  ) {
    const source = await readFile(`case-studies/ecs/${name}.blot`, "utf8");
    const formatted = await formatSource(source);
    assert.equal(formatted.ok, true);
    if (!formatted.ok) throw new Error(`${name} failed to format`);
    assert.equal(formatted.source, source, name);
  }
});
