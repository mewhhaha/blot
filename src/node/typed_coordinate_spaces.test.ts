import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/typed_coordinate_spaces.blot";
const expectedType =
  "{ .default = { .screen_vertices = [{ .frame = #Screen; .x = Int; .y = Int }]; .screen_offset = { .frame = #Screen; .dx = Int; .dy = Int }; .moved = { .frame = #Screen; .x = Int; .y = Int }; .same_target = { .frame = #Model; .x = Int; .y = Int } } }";

test("typed coordinate spaces preserve frame relationships in both executions", async () => {
  const compiler = await Compiler.create();
  try {
    for (const sourcePath of ["examples/lib/coordinate_space.blot", path]) {
      const source = await readFile(sourcePath, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error("accepted example failed to format");
      assert.equal(formatted.source, source);
    }

    assert.deepEqual(await compiler.check(path), {
      type: expectedType,
      effects: "",
    });

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/typed_coordinate_spaces.txt", "utf8")).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile("examples/expected/typed_coordinate_spaces.wasm.txt", "utf8")).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("coordinate spaces reject mismatches and document quantified widening", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const fixture of [
        "src/node/fixtures/coordinate_space_bad_compose.blot",
        "src/node/fixtures/coordinate_space_mixed_move.blot",
        "src/node/fixtures/coordinate_space_wrong_marker.blot",
      ]
    ) {
      await assert.rejects(() => compiler.check(fixture), /BLOT_TYPE_ERROR/);
    }

    assert.deepEqual(
      await compiler.check(
        "src/node/fixtures/coordinate_space_generic_same_frame_widens.blot",
      ),
      {
        type: "{ .frame = #Model | #World; .x = Int; .y = Int }",
        effects: "",
      },
    );
  } finally {
    compiler.destroy();
  }
});
