import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { runArtifact } from "./run.ts";

async function withSource(
  source: string,
  run: (compiler: Compiler, path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "blot-language-review-"));
  const path = join(directory, "main.blot");
  const compiler = await Compiler.create();
  try {
    await writeFile(path, source);
    await run(compiler, path);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
}

for (const precision of ["F64", "F32"]) {
  test(`${precision}.partial_cmp handles dynamic IEEE edge cases`, async () => {
    await withSource(
      `open import "blot:prelude"
const Float = import "blot:float"
let compare :: ${precision} -> ${precision} -> Float.PartialOrdering
let compare = Float.${precision}.partial_cmp
return compare
`,
      async (compiler, path) => {
        const artifact = await compiler.compile(path);
        const manifest = JSON.parse(
          new TextDecoder().decode(artifact.manifestBytes),
        );
        const exported = manifest.exports.find(
          (entry: { sourceName: string }) => entry.sourceName === "default",
        );
        assert.ok(exported);
        assert.equal(exported.function.parameters.length, 2);
        assert.equal(exported.function.result.kind, "variant");
        const names: string[] = exported.function.result.cases
          .map((entry: { name: string }) => entry.name).sort();
        assert.deepEqual(names, ["Equal", "Greater", "Less", "Unordered"]);
        const { instance } = await WebAssembly.instantiate(
          Uint8Array.from(artifact.wasm),
        );
        const compare = instance.exports[exported.name];
        assert.equal(typeof compare, "function");
        if (typeof compare !== "function") {
          throw new Error("missing comparison export");
        }
        const cases: readonly (readonly [number, number, string])[] = [
          [1, 2, "Less"],
          [2, 1, "Greater"],
          [2, 2, "Equal"],
          [0, -0, "Equal"],
          [-0, 0, "Equal"],
          [Infinity, Infinity, "Equal"],
          [-Infinity, -Infinity, "Equal"],
          [-Infinity, Infinity, "Less"],
          [Infinity, 1, "Greater"],
          [NaN, 1, "Unordered"],
          [1, NaN, "Unordered"],
          [NaN, NaN, "Unordered"],
          [NaN, Infinity, "Unordered"],
        ];
        for (const [left, right, expected] of cases) {
          const tag: unknown = compare(left, right);
          assert.equal(typeof tag, "number");
          assert.equal(names[tag as number], expected, `${left}, ${right}`);
        }
        if (precision === "F32") {
          assert.equal(names[compare(16777216, 16777217)], "Equal");
        } else {
          assert.equal(names[compare(16777216, 16777217)], "Less");
        }
      },
    );
  });

  test(`${precision}.partial_cmp agrees in evaluation and emitted Wasm`, async () => {
    await withSource(
      `open import "blot:prelude"
const Float = import "blot:float"
const compare = Float.${precision}.partial_cmp
let nan = ${precision}.of_int 0
let nan = ${precision}.div nan nan
return case compare nan (${precision}.of_int 1) of
  #Less => 0
  #Equal => 1
  #Greater => 2
  #Unordered => 3
`,
      async (compiler, path) => {
        assert.equal((await compiler.evaluate(path)).display, "3");
        assert.equal(await runArtifact(await compiler.compile(path)), "3");
      },
    );
  });

  test(`${precision}.cmp_exn preserves the explicit trapping operation`, async () => {
    await withSource(
      `open import "blot:prelude"
const Float = import "blot:float"
let less :: ${precision} -> ${precision} -> Int
let less = fn left => fn right => case is_less (Float.${precision}.cmp_exn left right) of
  #True => 1
  #False => 0
return less
`,
      async (compiler, path) => {
        const artifact = await compiler.compile(path);
        const { instance } = await WebAssembly.instantiate(
          Uint8Array.from(artifact.wasm),
        );
        const less = instance.exports["blot:default"];
        if (typeof less !== "function") {
          throw new Error("missing comparison export");
        }
        assert.equal(less(1, 2), 1n);
        assert.throws(() => less(NaN, 1), WebAssembly.RuntimeError);
        assert.throws(() => less(1, NaN), WebAssembly.RuntimeError);
      },
    );
  });
}

test("pipeline adapters preserve mapping, filtering, folding, and their input", async () => {
  await withSource(
    `open import "blot:prelude"
open import "blot:pipeline"
let original = [1, 2, 3, 4]
let result :: Int
let result = original
  |> map_with (fn value => value + 1)
  |> filter_with (fn value => value > 3)
  |> fold_with (fn (total, value) => total + value) 0
return result + sum original
`,
    async (compiler, path) => {
      assert.equal((await compiler.evaluate(path)).display, "19");
      assert.equal(await runArtifact(await compiler.compile(path)), "19");
    },
  );
});

test("pipeline adapters remain generic over Text and handle an empty array", async () => {
  await withSource(
    `open import "blot:prelude"
open import "blot:pipeline"
let words = ["a", "bb"] |> map_with (fn value => Text.length value)
let empty :: [Int]
let empty = []
let total = empty |> map_with (fn value => value + 1)
  |> filter_with (fn value => value > 0)
  |> fold_with (fn (state, value) => state + value) 0
return sum words + total
`,
    async (compiler, path) => {
      assert.equal((await compiler.evaluate(path)).display, "3");
      assert.equal(await runArtifact(await compiler.compile(path)), "3");
    },
  );
});

for (const value of ["4294967296", "9223372036854775807"]) {
  test(`full-width decimal literal ${value} reaches Wasm without truncation`, async () => {
    await withSource(`return ${value}\n`, async (compiler, path) => {
      assert.equal((await compiler.evaluate(path)).display, value);
      assert.equal(await runArtifact(await compiler.compile(path)), value);
    });
  });
}

test("oversized computed Int values are currently rejected, not truncated", async () => {
  await withSource(
    `open import "blot:prelude"
const wide = @int.mul 9223372036854775807 9223372036854775807
const reduced = @int.div wide 9223372036854775807
return reduced
`,
    async (compiler, path) => {
      await assert.rejects(
        () => compiler.compile(path),
        /BLOT_TYPE_ERROR: 85070591730234615847396907784232501249 does not flow into Int/,
      );
    },
  );
});

test("an explicit equality dictionary survives helper extraction", async () => {
  await withSource(
    `open import "blot:prelude"
let same_with = fn equal => fn left => fn right => equal left right
return same_with Text.eq "same" "same"
`,
    async (compiler, path) => {
      assert.equal(await runArtifact(await compiler.compile(path)), "true");
    },
  );
});
