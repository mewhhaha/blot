import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeValue } from "../../src/abi_values.ts";
import { Compiler } from "../../src/compiler.ts";
import { instantiateArtifact } from "../../src/host.ts";
import { observeArtifact } from "../../src/node/run.ts";
import { evaluationObservation } from "../../src/runtime_observation.ts";

type Vector = readonly [number, number, number, number];
type Matrix = readonly [Vector, Vector, Vector, Vector];

function record(fields: Record<string, RuntimeValue>): RuntimeValue {
  return { kind: "record", fields: new Map(Object.entries(fields)) };
}
function tuple(...values: RuntimeValue[]): RuntimeValue {
  return record(
    Object.fromEntries(values.map((value, index) => [String(index), value])),
  );
}
function vector(lanes: Vector): RuntimeValue {
  return record({ x: lanes[0], y: lanes[1], z: lanes[2], w: lanes[3] });
}
function matrix(columns: Matrix): RuntimeValue {
  return record({
    c0: vector(columns[0]),
    c1: vector(columns[1]),
    c2: vector(columns[2]),
    c3: vector(columns[3]),
  });
}
function four<T>(at: (index: number) => T): [T, T, T, T] {
  return [at(0), at(1), at(2), at(3)];
}
function transform(columns: Matrix, point: Vector): Vector {
  return four((row) => {
    const products = columns.map((column, index) =>
      Math.fround(Math.fround(column[row]) * Math.fround(point[index]))
    );
    return Math.fround(
      Math.fround(products[0] + products[1]) +
        Math.fround(products[2] + products[3]),
    );
  });
}
function multiply(left: Matrix, right: Matrix): Matrix {
  return four((column) => transform(left, right[column]));
}
const identity: Matrix = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [
  0,
  0,
  0,
  1,
]];
const translation: Matrix = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [
  10,
  20,
  30,
  1,
]];
const scale: Matrix = [[2, 0, 0, 0], [0, 3, 0, 0], [0, 0, 4, 0], [0, 0, 0, 1]];

test("SIMD matrices agree with scalar F32 arithmetic for runtime inputs", async () => {
  const compiler = await Compiler.create();
  try {
    const vectorType = "{ .x = F32; .y = F32; .z = F32; .w = F32 }";
    const matrixType = `{ ${
      [0, 1, 2, 3].map((column) => `.c${column} = ${vectorType}`).join("; ")
    } }`;
    for (const variant of ["simd", "scalar"]) {
      const checked = await compiler.check(
        `case-studies/ecs/kernels/${variant}-matrix.blot`,
      );
      assert.deepEqual(
        { type: checked.type, effects: checked.effects },
        {
          type:
            `{ .multiply = [{ .0 = ${matrixType}; .1 = ${matrixType} }] -> [${matrixType}]; .transform = [{ .0 = ${matrixType}; .1 = ${vectorType} }] -> [${vectorType}]; .product = { .0 = ${matrixType}; .1 = ${matrixType} } -> ${matrixType}; .point = { .0 = ${matrixType}; .1 = ${vectorType} } -> ${vectorType} }`,
          effects: "",
        },
      );
    }
    const simd = await instantiateArtifact(
      await compiler.compile("case-studies/ecs/kernels/simd-matrix.blot"),
    );
    const scalar = await instantiateArtifact(
      await compiler.compile("case-studies/ecs/kernels/scalar-matrix.blot"),
    );
    try {
      for (const guest of [simd, scalar]) {
        assert.deepEqual(guest.call("multiply", [[]]), []);
        assert.deepEqual(guest.call("transform", [[]]), []);
        const matrices = [identity, translation, scale];
        assert.deepEqual(
          guest.call("multiply", [
            matrices.map((right) => tuple(matrix(translation), matrix(right))),
          ]),
          matrices.map((right) => matrix(multiply(translation, right))),
        );
      }
      const matrices: Matrix[] = [
        identity,
        translation,
        scale,
        [[0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
        [[0, -0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16]],
      ];
      for (let seed = 0; seed < 12; seed += 1) {
        matrices.push(
          four((column) =>
            four((row) =>
              Math.fround(Math.sin(seed * 17 + column * 5 + row) * 9)
            )
          ),
        );
      }
      const points: Vector[] = [[1, 2, 3, 1], [1, 2, 3, 0], [0, -0, 0, -0], [
        0.1,
        -123.25,
        0.00001,
        1,
      ]];
      for (const left of matrices) {
        for (const right of matrices) {
          const expected = [matrix(multiply(left, right))];
          const args = [[tuple(matrix(left), matrix(right))]];
          assert.deepEqual(simd.call("multiply", args), expected);
          assert.deepEqual(scalar.call("multiply", args), expected);
          assert.deepEqual(simd.call("product", [args[0][0]]), expected[0]);
          assert.deepEqual(scalar.call("product", [args[0][0]]), expected[0]);
        }
        for (const point of points) {
          const args = [[tuple(matrix(left), vector(point))]];
          const expected = [vector(transform(left, point))];
          assert.deepEqual(simd.call("transform", args), expected);
          assert.deepEqual(scalar.call("transform", args), expected);
          assert.deepEqual(simd.call("point", [args[0][0]]), expected[0]);
          assert.deepEqual(scalar.call("point", [args[0][0]]), expected[0]);
        }
      }
      assert.notDeepEqual(
        multiply(translation, scale),
        multiply(scale, translation),
      );
    } finally {
      simd.destroy();
      scalar.destroy();
    }
  } finally {
    compiler.destroy();
  }
});

test("the same ECS graph specializes for scalar and SIMD transform components", async () => {
  const compiler = await Compiler.create();
  try {
    const simd = await instantiateArtifact(
      await compiler.compile("case-studies/ecs/kernels/simd-transforms.blot"),
    );
    const scalar = await instantiateArtifact(
      await compiler.compile("case-studies/ecs/kernels/scalar-transforms.blot"),
    );
    try {
      for (const length of [0, 1, 5, 17]) {
        const rows = Array.from({ length }, (_, index) =>
          record({
            Id: BigInt(index),
            Parent: matrix(translation),
            Local: matrix(scale),
            World: matrix(identity),
            Point: vector([index - 3, index / 4, 2, 1]),
            Projected: vector([999, 999, 999, 999]),
            Age: BigInt(index),
          }));
        let simdRows: RuntimeValue = rows;
        let scalarRows: RuntimeValue = rows;
        for (let frame = 1; frame <= 3; frame += 1) {
          const world = multiply(translation, scale);
          const expected = Array.from({ length }, (_, index) =>
            record({
              Id: BigInt(index),
              Parent: matrix(translation),
              Local: matrix(scale),
              World: matrix(world),
              Point: vector([index - 3, index / 4, 2, 1]),
              Projected: vector(transform(world, [index - 3, index / 4, 2, 1])),
              Age: BigInt(index + frame),
            }));
          simdRows = simd.call("default", [simdRows]);
          scalarRows = scalar.call("default", [scalarRows]);
          assert.deepEqual(simdRows, expected);
          assert.deepEqual(scalarRows, expected);
        }
      }
    } finally {
      simd.destroy();
      scalar.destroy();
    }
  } finally {
    compiler.destroy();
  }
});

test("SIMD particle blocks preserve every live lane and omit padding", async () => {
  const compiler = await Compiler.create();
  try {
    const entity = "{ .Position = F32; .Velocity = F32 }";
    for (const variant of ["simd", "scalar"]) {
      const checked = await compiler.check(
        `case-studies/ecs/kernels/${variant}-particles.blot`,
      );
      assert.deepEqual(
        { type: checked.type, effects: checked.effects },
        {
          type: `{ .0 = [${entity}]; .1 = Int } -> [${entity}]`,
          effects: "",
        },
      );
    }
    const simd = await instantiateArtifact(
      await compiler.compile("case-studies/ecs/kernels/simd-particles.blot"),
    );
    const scalar = await instantiateArtifact(
      await compiler.compile("case-studies/ecs/kernels/scalar-particles.blot"),
    );
    try {
      for (
        const length of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 65, 129]
      ) {
        const initial = Array.from(
          { length },
          (_, index) => ({
            Position: Math.fround(index % 17 - 4.25),
            Velocity: Math.fround(index % 7 - 2.5),
          }),
        );
        for (const frames of [0, 1, 7]) {
          let expected = initial;
          for (let frame = 0; frame < frames; frame += 1) {
            expected = expected.map((row) => {
              const Position = Math.fround(row.Position + row.Velocity);
              let Velocity = row.Velocity;
              if (!(Position < 10)) Velocity = Math.fround(0 - Velocity);
              return { Position, Velocity };
            });
          }
          const args = [tuple(initial.map(record), BigInt(frames))];
          assert.deepEqual(
            simd.call("default", args),
            expected.map(record),
            `${length} entities, ${frames} frames`,
          );
          assert.deepEqual(scalar.call("default", args), expected.map(record));
        }
      }
      const special = [
        { Position: NaN, Velocity: 2 },
        { Position: Infinity, Velocity: -1 },
        { Position: -Infinity, Velocity: 1 },
        { Position: -0, Velocity: -0 },
      ];
      const args = [tuple(special.map(record), 1n)];
      assert.deepEqual(
        simd.call("default", args),
        scalar.call("default", args),
      );
    } finally {
      simd.destroy();
      scalar.destroy();
    }
  } finally {
    compiler.destroy();
  }
});

test("SIMD examples agree between evaluation and emitted Wasm", async () => {
  const compiler = await Compiler.create();
  try {
    for (const name of ["main", "matrices"]) {
      const path = `case-studies/ecs/simd/${name}.blot`;
      const evaluated = await compiler.evaluate(path);
      const emitted = await observeArtifact(await compiler.compile(path));
      assert.deepEqual(
        evaluationObservation(evaluated.value, {
          kind: "record",
          fields: [{ name: "default", type: emitted.type }],
        }),
        record({ default: emitted.value }),
      );
      assert.deepEqual(evaluated.writes, []);
    }
  } finally {
    compiler.destroy();
  }
});

test("SIMD kernels retain vector arithmetic and owned Store updates", async () => {
  const compiler = await Compiler.create();
  try {
    for (const workload of ["matrix", "transforms", "particles"]) {
      for (const variant of ["simd", "scalar"]) {
        const path = `case-studies/ecs/kernels/${variant}-${workload}.blot`;
        const hir = await compiler.prepare(path);
        assert.deepEqual(hir.capabilities, []);
        const operations = hir.functions.flatMap((fn) =>
          fn.continuations.flatMap((block) =>
            block.instructions.map(({ operation }) => operation)
          )
        );
        const vectors = operations.filter((operation) =>
          operation.kind === "vector"
        );
        if (variant === "simd") {
          assert.ok(vectors.some((operation) => operation.operator === "add"));
          if (workload !== "particles") {
            assert.ok(
              vectors.some((operation) => operation.operator === "multiply"),
            );
          }
          if (workload === "particles") {
            assert.ok(
              vectors.some((operation) => operation.operator === "select"),
            );
          }
        } else {
          assert.equal(vectors.length, 0);
        }
        for (const operation of operations) {
          assert.ok(!operation.kind.startsWith("indirect."));
          if (
            operation.kind === "store.grow" || operation.kind === "store.write"
          ) assert.equal(operation.update, "owned-reuse");
        }
      }
    }
  } finally {
    compiler.destroy();
  }
});

test("conditional SIMD unpacking preserves empty tables and every partial block", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "case-studies/ecs/simd/partial-blocks.blot";
    const guest = await instantiateArtifact(await compiler.compile(path));
    try {
      for (const count of [0, 1, 2, 3, 4, 5, 6, 7, 8, 17, 129]) {
        const rows = Array.from(
          { length: count },
          (_, index) =>
            record({ Position: Math.fround(index / 4), Velocity: -0 }),
        );
        assert.deepEqual(guest.call("default", [rows]), rows);
      }
    } finally {
      guest.destroy();
    }
  } finally {
    compiler.destroy();
  }
});
