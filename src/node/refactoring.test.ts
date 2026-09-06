import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler, type CompilerArtifact } from "../compiler.ts";
import { buildPackage } from "../package.ts";

const prelude = 'open import "blot:prelude"\n';
const inputs = [-3n, 0n, 42n];

async function runScalars(artifact: CompilerArtifact): Promise<unknown[]> {
  assert.equal(WebAssembly.validate(Uint8Array.from(artifact.wasm)), true);
  const { instance } = await WebAssembly.instantiate(
    Uint8Array.from(artifact.wasm),
  );
  const run = instance.exports["blot:default"];
  assert.equal(typeof run, "function");
  if (typeof run !== "function") throw new Error("missing default export");
  return inputs.map((input) => run(input));
}

const products = [
  {
    name: "direct expression",
    declarations: "",
    body: "@int.add number 7",
  },
  {
    name: "destructured helper",
    declarations: "const add = fn (left, right) => @int.add left right\n",
    body: "add (number, 7)",
  },
  {
    name: "named product helper",
    declarations: "const add = fn pair => @int.add pair.0 pair.1\n",
    body: "do:\n  let pair = (number, 7)\n  return add pair",
  },
  {
    name: "imported structural helper",
    declarations: 'const add = import "./add.blot"\n',
    body: "add { .left = number; .right = 7; .extra = 100; }",
  },
] as const;

for (const variant of products) {
  test(`refactoring preserves runtime results: ${variant.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-refactoring-"));
    const compiler = await Compiler.create();
    try {
      const path = join(directory, "main.blot");
      await writeFile(
        join(directory, "add.blot"),
        "return fn pair => @int.add pair.left pair.right\n",
      );
      await writeFile(
        path,
        `${prelude}${variant.declarations}let run :: Int -> Int
let run = fn number => ${variant.body}
return run
`,
      );
      assert.deepEqual(await compiler.check(path), {
        type: "Int -> Int",
        effects: "",
      });
      const cold = await compiler.compile(path);
      const warm = await compiler.compile(path);
      assert.equal(warm.artifactSource, "revision-cache");
      assert.deepEqual(warm.wasm, cold.wasm);
      assert.deepEqual(warm.manifestBytes, cold.manifestBytes);
      assert.deepEqual(await runScalars(cold), [4n, 7n, 49n]);
      for (const input of inputs) {
        const evaluation = join(directory, "evaluate.blot");
        await writeFile(
          evaluation,
          `const run = import "./main.blot"\nreturn run (${input})\n`,
        );
        assert.equal(
          (await compiler.evaluate(evaluation)).display,
          String(input + 7n),
        );
      }
    } finally {
      compiler.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("a source-free capsule preserves an inferred structural helper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-refactoring-capsule-"));
  try {
    const packageRoot = join(directory, "node_modules", "@test", "addition");
    await mkdir(packageRoot, { recursive: true });
    const library = join(packageRoot, "mod.blot");
    await writeFile(
      library,
      "return fn pair => @int.add pair.left pair.right\n",
    );
    const manifest = join(packageRoot, "blot.json");
    await writeFile(
      manifest,
      JSON.stringify({
        schema: "blot-package",
        version: 4,
        exports: { ".": { source: "./mod.blot", built: "./dist/mod.blotc" } },
      }),
    );
    const built = await buildPackage(manifest);
    assert.equal(built.length, 1);
    assert.ok(built[0].bytes > 0);
    await rm(library);
    const path = join(directory, "main.blot");
    await writeFile(
      path,
      `${prelude}const add = import "@test/addition"
let run :: Int -> Int
let run = fn number => add { .left = number; .right = 7; .extra = 100; }
return run
`,
    );
    const compiler = await Compiler.create();
    try {
      assert.deepEqual(await compiler.check(path), {
        type: "Int -> Int",
        effects: "",
      });
      assert.deepEqual(await runScalars(await compiler.compile(path)), [
        4n,
        7n,
        49n,
      ]);
    } finally {
      compiler.destroy();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dependency edits agree between resident and fresh compiler sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-refactoring-revision-"));
  const compiler = await Compiler.create();
  try {
    const helper = join(directory, "offset.blot");
    const path = join(directory, "main.blot");
    await writeFile(helper, "return fn number => @int.add number 7\n");
    await writeFile(
      path,
      `${prelude}const offset = import "./offset.blot"
let run :: Int -> Int
let run = fn number => offset number
return run
`,
    );
    assert.deepEqual(await runScalars(await compiler.compile(path)), [
      4n,
      7n,
      49n,
    ]);
    await writeFile(helper, "return fn number => @int.add number 9\n");
    await compiler.markChanged(helper);
    const resident = await compiler.compile(path);
    assert.equal(resident.artifactSource, "compiled");
    assert.deepEqual(await runScalars(resident), [6n, 9n, 51n]);
    const fresh = await Compiler.create();
    try {
      const rebuilt = await fresh.compile(path);
      assert.deepEqual(resident.wasm, rebuilt.wasm);
      assert.deepEqual(resident.manifestBytes, rebuilt.manifestBytes);
      assert.deepEqual(await compiler.check(path), await fresh.check(path));
    } finally {
      fresh.destroy();
    }
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const imported of [false, true]) {
  test(`qualified equality survives helper extraction (imported=${imported})`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "blot-refactoring-operator-"),
    );
    const compiler = await Compiler.create();
    try {
      await writeFile(
        join(directory, "same.blot"),
        `${prelude}return fn left => fn right => left == right\n`,
      );
      let declaration = "const same = fn left => fn right => left == right";
      if (imported) declaration = 'const same = import "./same.blot"';
      const path = join(directory, "main.blot");
      await writeFile(
        path,
        `${prelude}${declaration}
let run :: Int -> Int
let run = fn number => case same number 42 of
  #True => 1
  #False => 0
return run
`,
      );
      assert.deepEqual(await runScalars(await compiler.compile(path)), [
        0n,
        0n,
        1n,
      ]);
      const evaluation = join(directory, "evaluate.blot");
      await writeFile(
        evaluation,
        `${prelude}${declaration}\nreturn case same "same" "same" of\n  #True => 1\n  #False => 0\n`,
      );
      assert.equal((await compiler.evaluate(evaluation)).display, "1");
    } finally {
      compiler.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
