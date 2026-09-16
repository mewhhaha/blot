import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/reversible_protocols.blot";
const expectedType =
  "{ .default = { .reviewed = #Reviewed { .title = Text; .body = Text; .reviewer = Text }; .review_restored = #Draft { .title = Text; .body = Text }; .published = #Published { .title = Text; .slug = Text }; .receipt = #Receipt Text; .restored = #Draft { .title = Text; .body = Text }; .edge_restored = #Draft { .title = Text; .body = Text } } }";

const blotSources = [
  "examples/lib/reversible_protocol.blot",
  "examples/lib/article_protocol.blot",
  path,
  "src/node/fixtures/reversible_protocol_wrong_order.blot",
  "src/node/fixtures/reversible_protocol_wrong_state.blot",
  "src/node/fixtures/reversible_protocol_wrong_undo.blot",
];

test("reversible protocols preserve staged state and undo evidence in both executions", async () => {
  for (const sourcePath of blotSources) {
    const source = await readFile(sourcePath, "utf8");
    const formatted = await formatSource(source);
    assert.equal(formatted.ok, true);
    if (!formatted.ok) throw new Error(`${sourcePath} failed to format`);
    assert.equal(formatted.source, source, `${sourcePath} is not canonical`);
  }

  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check(path);
    assert.deepEqual({
      type: checked.type,
      effects: checked.effects,
    }, {
      type: expectedType,
      effects: "",
    });

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/reversible_protocols.txt", "utf8"))
        .trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (
        await readFile(
          "examples/expected/reversible_protocols.wasm.txt",
          "utf8",
        )
      ).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("reversible protocols reject non-adjacent stages and mismatched undo evidence", async () => {
  const compiler = await Compiler.create();
  try {
    for (
      const fixture of [
        "src/node/fixtures/reversible_protocol_wrong_order.blot",
        "src/node/fixtures/reversible_protocol_wrong_state.blot",
        "src/node/fixtures/reversible_protocol_wrong_undo.blot",
      ]
    ) {
      await assert.rejects(() => compiler.check(fixture), /BLOT_TYPE_ERROR/);
    }
  } finally {
    compiler.destroy();
  }
});
