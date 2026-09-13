import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeValue } from "../abi_values.ts";
import { Compiler } from "../compiler.ts";
import { instantiateArtifact } from "../host.ts";
import { observeArtifact } from "./run.ts";
import { evaluationObservation } from "../runtime_observation.ts";

function tuple(...values: RuntimeValue[]): RuntimeValue {
  return {
    kind: "record",
    fields: new Map(values.map((value, index) => [String(index), value])),
  };
}

const source = `open import "blot:prelude"
const split :: (Text, Text) -> [Text]
const split = fn pair => Text.split pair
const replace :: (Text, Text, Text) -> Text
const replace = fn triple => Text.replace triple
const slice :: (Text, Int, Int) -> Text
const slice = fn (text, start, end) => @text.slice_bytes text start end
const scalar_slice :: (Text, Int, Int) -> Text
const scalar_slice = fn (text, start, end) => @text.slice text start end
const find :: (Text, Text, Int) -> Int
const find = fn (text, query, start) => @text.find_byte_from text query start
return { .split = split; .replace = replace; .slice = slice; .scalar_slice = scalar_slice; .find = find; }
`;

test("composite Text traversal agrees for Unicode, dense delimiters and empty searches", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-text-composition-"));
  const compiler = await Compiler.create();
  try {
    const path = join(directory, "text.blot");
    await writeFile(path, source);
    const guest = await instantiateArtifact(await compiler.compile(path));
    try {
      for (
        const [text, query, replacement] of [
          ["", "", "z"],
          ["a🐱é🐱", "🐱", "β"],
          ["aaaaa", "aa", "b"],
          ["x\0y\0", "\0", "🐱"],
          ["a\nb\n", "\n", ""],
          ["unchanged", "", "x"],
          ["α🐱\n".repeat(8192), "\n", "🐱"],
          ["a\n".repeat(16384), "\n", ""],
        ]
      ) {
        let split = [text];
        let replaced = text;
        if (query !== "") {
          split = text.split(query);
          replaced = split.join(replacement);
        }
        assert.deepEqual(guest.call("split", [tuple(text, query)]), split);
        assert.equal(
          guest.call("replace", [tuple(text, query, replacement)]),
          replaced,
        );
        if (text.length < 100) {
          const observe = join(directory, "observe.blot");
          // Blot and JSON share these literal escapes; keep the NUL case in the host probe.
          if (!text.includes("\0")) {
            await writeFile(
              observe,
              `open import "blot:prelude"\nreturn (Text.split (${
                JSON.stringify(text)
              }, ${JSON.stringify(query)}), Text.replace (${
                JSON.stringify(text)
              }, ${JSON.stringify(query)}, ${JSON.stringify(replacement)}))\n`,
            );
            const evaluated = await compiler.evaluate(observe);
            const emitted = await observeArtifact(
              await compiler.compile(observe),
            );
            assert.deepEqual(
              evaluationObservation(evaluated.value, emitted.type),
              emitted.value,
            );
          }
        }
      }
      assert.equal(guest.call("slice", [tuple("aé🐱", 1n, 7n)]), "é🐱");
      assert.equal(guest.call("slice", [tuple("aé🐱", 7n, 7n)]), "");
      assert.equal(guest.call("find", [tuple("aé🐱é", "é", 3n)]), 7n);
      assert.equal(guest.call("find", [tuple("aé🐱", "", 7n)]), 7n);
      assert.equal(guest.call("find", [tuple("aé🐱", "x", 1n)]), -1n);
    } finally {
      await guest.close();
    }
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});

test("raw Text byte operations reject forged boundaries and reversed slices", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blot-text-boundaries-"));
  const compiler = await Compiler.create();
  try {
    const path = join(directory, "text.blot");
    await writeFile(path, source);
    const artifact = await compiler.compile(path);
    const invalid: [string, RuntimeValue][] = [
      ["slice", tuple("é", -1n, 2n)],
      ["slice", tuple("é", 1n, 2n)],
      ["slice", tuple("é", 2n, 0n)],
      ["slice", tuple("é", 0n, 3n)],
      ["find", tuple("é", "", 1n)],
      ["find", tuple("é", "", 3n)],
      ["find", tuple("é", "", -1n)],
      ["scalar_slice", tuple("ab", 2n, 1n)],
    ];
    for (const [name, argument] of invalid) {
      const guest = await instantiateArtifact(artifact);
      try {
        assert.throws(
          () => guest.call(name, [argument]),
          WebAssembly.RuntimeError,
        );
      } finally {
        await guest.close();
      }
    }
    const observe = join(directory, "invalid.blot");
    for (
      const expression of [
        '@text.slice_bytes "é" 1 2',
        '@text.slice_bytes "é" 2 0',
        '@text.find_byte_from "é" "" 1',
      ]
    ) {
      await writeFile(observe, `return ${expression}\n`);
      await assert.rejects(
        () => compiler.evaluate(observe),
        /BLOT_TEXT_BYTE_BOUNDS/,
      );
    }
  } finally {
    compiler.destroy();
    await rm(directory, { recursive: true });
  }
});
