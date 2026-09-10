import { scalarExport } from "../../test_support/guest_abi.ts";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { buildPackage } from "../package.ts";

const prelude = 'open import "blot:prelude"\n';
const predicate = "return fn (index, length) => index >= 0 && index < length\n";
const indices = [-3n, -1n, 0n, 1n, 2n, 9223372036854775807n];
const expected = [0n, 0n, 10n, 20n, 0n, 0n];

for (const placement of ["local", "import", "capsule"] as const) {
  test(`predicate helper retains runtime bounds through ${placement}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-predicate-helper-"));
    try {
      let declaration =
        "const fits = fn (index, length) => index >= 0 && index < length\n";
      if (placement === "import") {
        await writeFile(join(directory, "fits.blot"), prelude + predicate);
        declaration = 'const fits = import "./fits.blot"\n';
      }
      if (placement === "capsule") {
        const packageRoot = join(directory, "node_modules", "@test", "bounds");
        await mkdir(packageRoot, { recursive: true });
        const source = join(packageRoot, "mod.blot");
        const manifest = join(packageRoot, "blot.json");
        await writeFile(source, prelude + predicate);
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
        declaration = 'const fits = import "@test/bounds"\n';
      }
      const compiler = await Compiler.create();
      try {
        const path = join(directory, "main.blot");
        await writeFile(
          path,
          `${prelude}${declaration}let run :: Int -> Int
let run = fn index => do:
  let values = [10, 20]
  if fits (index, @array.len values):
    return @array.get values index
  return 0
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
        if (typeof run !== "function") {
          throw new Error("missing runtime export");
        }
        assert.deepEqual(indices.map((index) => run(index)), expected);
        for (let index = 0; index < indices.length; index += 1) {
          const evaluation = join(directory, "evaluate.blot");
          await writeFile(
            evaluation,
            `const run = import "./main.blot"\nreturn run (${
              indices[index]
            })\n`,
          );
          assert.equal(
            (await compiler.evaluate(evaluation)).display,
            String(expected[index]),
          );
        }
      } finally {
        compiler.destroy();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

const unsafe = [
  {
    name: "an arbitrary true-returning helper",
    declaration: "const fits = fn pair => True",
    condition: "fits (index, @array.len values)",
    consequence: "return @array.get values index",
  },
  {
    name: "a callback shadowing a captured comparison",
    declaration: `const less = fn left => fn right => left < right
const fits = fn (index, length, less) => index >= 0 && less index length
const always = fn left => fn right => True`,
    condition: "fits (index, @array.len values, always)",
    consequence: "return @array.get values index",
  },
  {
    name: "an incremented index without a new check",
    declaration:
      "const fits = fn (index, length) => index >= 0 && index < length",
    condition: "fits (index, @array.len values)",
    consequence:
      "let next = @int.add index 1\n    return @array.get values next",
  },
  {
    name: "a different captured lower bound",
    declaration:
      `const make = fn lower => fn (index, length) => index >= lower && index < length
const safe = make 0
const fits = make (-1)`,
    condition: "fits (index, @array.len values)",
    consequence: "return @array.get values index",
  },
];

for (const fixture of unsafe) {
  test(`predicate helper refuses ${fixture.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "blot-unsafe-helper-"));
    const compiler = await Compiler.create();
    try {
      const path = join(directory, "main.blot");
      await writeFile(
        path,
        `${prelude}${fixture.declaration}
let run :: Int -> Int
let run = fn index => do:
  let values = [10, 20]
  if ${fixture.condition}:
    ${fixture.consequence}
  return 0
return run
`,
      );
      await assert.rejects(() => compiler.check(path), /BLOT_UNPROVEN_INDEX/);
    } finally {
      compiler.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
