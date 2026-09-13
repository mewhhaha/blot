import { buildPackage } from "../package.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { scalarExport } from "../../test_support/guest_abi.ts";

for (const placement of ["source", "capsule", "offset"]) {
  test(`relational helpers and traversals agree through ${placement}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-relational-"));
    const compiler = await Compiler.create();
    try {
      let librarySource = await readFile(
        new URL(
          "../../examples/lib/relational_inference.blot",
          import.meta.url,
        ),
        "utf8",
      );
      if (placement === "offset") {
        librarySource = librarySource
          .replace(
            "if index >= Array.length values:",
            "if index >= Array.length values + 2:",
          )
          .replace(
            "let value = @array.get values index",
            "let value = @array.get values (index - 2)",
          )
          .replace("visit (0, 0)", "visit (2, 0)");
      }
      await writeFile(join(directory, "relations.blot"), librarySource);
      let importPath = "./relations.blot";
      if (placement === "capsule") {
        const root = join(directory, "node_modules", "@test", "relations");
        await mkdir(root, { recursive: true });
        const source = join(root, "mod.blot");
        await writeFile(
          source,
          await readFile(join(directory, "relations.blot"), "utf8"),
        );
        const manifest = join(root, "blot.json");
        await writeFile(
          manifest,
          JSON.stringify({
            schema: "blot-package",
            version: 4,
            exports: { ".": { source: "./mod.blot", built: "./mod.blotc" } },
          }),
        );
        await buildPackage(manifest);
        await rm(source);
        importPath = "@test/relations";
      }
      const path = join(directory, "main.blot");
      await writeFile(
        path,
        `open import "blot:prelude"
const relations = import "${importPath}"
const run :: Int -> Int
const run = fn index => do:
  let values = [10, 20, 30]
  return relations.next_at (values, index) + relations.clamped_at (values, index) + relations.optional_at (values, index) + relations.sum values + relations.sum_loop values
return run
`,
      );
      assert.deepEqual(await compiler.check(path), {
        type: "Int -> Int",
        effects: "",
      });
      const cold = await compiler.compile(path);
      const warm = await compiler.compile(path);
      assert.deepEqual(cold.wasm, warm.wasm);
      const { instance } = await WebAssembly.instantiate(
        Uint8Array.from(cold.wasm),
      );
      const run = scalarExport(instance, "blot:default");
      for (
        const [argument, expected] of [[-10n, 128n], [0n, 160n], [1n, 190n], [
          2n,
          179n,
        ], [3n, 117n]]
      ) {
        assert.equal(run(argument), expected);
        const evaluation = join(directory, "evaluate.blot");
        await writeFile(
          evaluation,
          `const run = import "./main.blot"\nreturn run (${argument})\n`,
        );
        assert.equal(
          (await compiler.evaluate(evaluation)).display,
          String(expected),
        );
      }
      const library = join(directory, "relations.blot");
      const analysis = await compiler.analyze(library);
      assert(
        analysis.refinements.some((fact) =>
          fact.kind === "recursive-invariant"
        ),
      );
      const access = analysis.refinements.find((fact) =>
        fact.kind === "array-index"
      );
      assert(access !== undefined);
      assert.equal(
        (await compiler.explain(library, access.span.start))?.kind,
        "refinement",
      );
      const overflow = join(directory, "overflow.blot");
      await writeFile(
        overflow,
        `const relations = import "${importPath}"\nreturn relations.increment\n`,
      );
      const incrementArtifact = await compiler.compile(overflow);
      const incrementInstance = await WebAssembly.instantiate(
        Uint8Array.from(incrementArtifact.wasm),
      );
      const increment = scalarExport(
        incrementInstance.instance,
        "blot:default",
      );
      assert.throws(
        () => increment(9223372036854775807n),
        WebAssembly.RuntimeError,
      );
      const traversal = join(directory, "traversal.blot");
      await writeFile(
        traversal,
        `open import "blot:prelude"
const relations = import "${importPath}"
const run :: Int -> Int
const run = fn count => do:
  let values = Iter.collect (Iter.range (0, count))
  return relations.sum values + relations.sum_loop values
return run
`,
      );
      const traversalArtifact = await compiler.compile(traversal);
      const traversalInstance = await WebAssembly.instantiate(
        Uint8Array.from(traversalArtifact.wasm),
      );
      assert.equal(
        scalarExport(traversalInstance.instance, "blot:default")(100000n),
        9999900000n,
      );
      if (placement === "source") {
        const original = await readFile(library, "utf8");
        const changed = original.replace(
          "fn value => value + 1",
          "fn value => value + 2",
        );
        assert.notEqual(changed, original);
        await assert.rejects(
          () => compiler.checkSource(library, changed),
          /BLOT_UNPROVEN_INDEX/,
        );
        await compiler.checkSource(library, original);
        assert.deepEqual((await compiler.compile(path)).wasm, cold.wasm);
      }
    } finally {
      compiler.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("primitive operator resolution does not redispatch through attachments", async () => {
  const compiler = await Compiler.create();
  const directory = await mkdtemp(join(tmpdir(), "blot-relational-operator-"));
  const prefix = `open import "blot:prelude"
const fake_add :: @type.int -> @type.int -> @type.int
const fake_add = fn left => fn right => @int.add left 100
const Scalar = @type.attach @type.int "add" fake_add
const step :: @type.int -> @type.int
const step = fn value => @type.resolve_member "add" value 1
const run :: @type.int -> @type.int
`;
  try {
    await assert.rejects(
      () =>
        compiler.checkSource(
          join(directory, "unsafe.blot"),
          `${prefix}
const run = fn index => do:
  if index >= -100 && index < -99:
    let next = step index
    return @array.get [1] next
  return 0
return run
`,
        ),
      /BLOT_UNPROVEN_INDEX|BLOT_OUT_OF_BOUNDS/,
    );
    const path = join(directory, "safe.blot");
    await writeFile(
      path,
      `${prefix}
const run = fn index => do:
  if index >= 0 && index < 1:
    let next = step index
    return @array.get [10, 20] next
  return 0
return run
`,
    );
    const artifact = await compiler.compile(path);
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    assert.equal(scalarExport(instance, "blot:default")(0n), 20n);
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

test("loop state crosses statement conditionals in evaluator and Wasm", async () => {
  const compiler = await Compiler.create();
  const directory = await mkdtemp(join(tmpdir(), "blot-nested-loop-"));
  try {
    const path = join(directory, "main.blot");
    await writeFile(
      path,
      `open import "blot:prelude"
const run :: Int -> Int
const run = fn count => do:
  let total = 0
  let value = 100
  if count > 0:
    for value in Iter.items [1, 2]:
      value := value + 1
      total := total + value
  return total + value
return run
`,
    );
    const artifact = await compiler.compile(path);
    const { instance } = await WebAssembly.instantiate(
      Uint8Array.from(artifact.wasm),
    );
    const run = scalarExport(instance, "blot:default");
    for (const [count, expected] of [[0n, 100n], [2n, 105n], [20n, 105n]]) {
      assert.equal(run(count), expected);
      const evaluation = join(directory, "evaluate.blot");
      await writeFile(
        evaluation,
        `const run = import "./main.blot"\nreturn run ${count}\n`,
      );
      assert.equal(
        (await compiler.evaluate(evaluation)).display,
        String(expected),
      );
    }
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
