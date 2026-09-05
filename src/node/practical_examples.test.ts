import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examples = [
  "idempotent_events",
  "paginated_feed",
  "sensor_units",
  "unicode_preview",
];

for (const name of examples) {
  test(`${name} executes its exact recorded Wasm result`, async () => {
    const compiler = await Compiler.create();
    try {
      const artifact = await compiler.compile(`examples/${name}.blot`);
      const expected = await readFile(
        `examples/expected/${name}.wasm.txt`,
        "utf8",
      );
      assert.equal(await runArtifact(artifact), expected.trim());
    } finally {
      compiler.destroy();
    }
  });

  test(`${name} retains canonical formatting and pain-point comments`, async () => {
    const source = await readFile(`examples/${name}.blot`, "utf8");
    assert.match(source, /Pain point:/);
    const formatted = await formatSource(source);
    assert.equal(formatted.ok, true);
    if (!formatted.ok) throw new Error("accepted example failed to format");
    assert.equal(formatted.source, source);
  });
}

for (
  const [name, capability] of [
    ["capabilities", "Init"],
    ["projected", "Console"],
    ["tour", "Init"],
  ]
) {
  test(`${name} compiles one effectful runtime aggregate`, async () => {
    const compiler = await Compiler.create();
    try {
      const artifact = await compiler.compile(`examples/${name}.blot`);
      const manifest = JSON.parse(
        new TextDecoder().decode(artifact.manifestBytes),
      );
      const exports = manifest.exports as {
        sourceName: string;
        phase: string;
      }[];
      assert.deepEqual(
        exports.filter((entry) => entry.phase === "runtime").map((entry) =>
          entry.sourceName
        ),
        ["default"],
      );
      assert.deepEqual(artifact.capabilities, [capability]);
      if (name === "tour") {
        assert.deepEqual(
          exports.filter((entry) => entry.phase === "comptime").map((entry) =>
            entry.sourceName
          ),
          ["small", "message"],
        );
      }
    } finally {
      compiler.destroy();
    }
  });
}
