import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Compiler } from "../../src/compiler.ts";
import { instantiateArtifact } from "../../src/host.ts";

const compiler = await Compiler.create();
try {
  const path = "/tmp/blot-text-composition-benchmark.blot";
  await compiler.checkSource(
    path,
    `open import "blot:prelude"
const lines :: Text -> Int
const lines = fn text => Array.length (Text.lines text)
const replace :: Text -> Int
const replace = fn text => Text.length (Text.replace (text, "\\n", "|"))
const length :: Text -> Int
const length = fn text => Text.length text
return { .lines; .replace; .length; }
`,
  );
  const guest = await instantiateArtifact(await compiler.compile(path));
  const measurements = [];
  try {
    for (const delimiters of [256, 512, 1024, 2048, 4096]) {
      const input = "a\n".repeat(delimiters);
      for (const name of ["lines", "replace", "length"]) {
        let expected = BigInt(delimiters * 2);
        if (name === "lines") expected = BigInt(delimiters + 1);
        for (let warmup = 0; warmup < 3; warmup += 1) {
          assert.equal(await guest.callAsync(name, [input]), expected);
        }
        const milliseconds = [];
        for (let sample = 0; sample < 7; sample += 1) {
          const start = performance.now();
          const actual = await guest.callAsync(name, [input]);
          milliseconds.push(performance.now() - start);
          assert.equal(actual, expected);
        }
        measurements.push({
          name,
          delimiters,
          inputBytes: input.length,
          medianMilliseconds: milliseconds.toSorted((a, b) => a - b)[3],
          milliseconds,
        });
      }
    }
  } finally {
    await guest.close();
  }
  console.log(JSON.stringify(
    {
      schema: 1,
      host: process.versions,
      compiler: JSON.parse(
        await readFile(
          new URL(
            "../../generated/compiler/compiler-artifact.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
      measurements,
    },
    null,
    2,
  ));
} finally {
  compiler.destroy();
}
