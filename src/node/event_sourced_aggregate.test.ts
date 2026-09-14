import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/event_sourced_aggregate.blot";
const expectedType =
  "{ .default = { .accepted_allocated = Int; .accepted_available = Int; .accepted_events = Int; .batch_allocated = Int; .batch_available = Int; .batch_events = Int; .empty_allocated = Int; .empty_available = Int; .invalid_count = Int; .rejected_available = Int; .rejected_requested = Int; .replayed_allocated = Int; .replayed_available = Int; .round_trip_allocated = Int; .round_trip_available = Int } }";

test("event-sourced aggregate preserves command/event/state relationships", async () => {
  const compiler = await Compiler.create();
  try {
    for (const sourcePath of [
      "examples/lib/event_sourced_aggregate.blot",
      path,
    ]) {
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
      (await readFile("examples/expected/event_sourced_aggregate.txt", "utf8")).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile("examples/expected/event_sourced_aggregate.wasm.txt", "utf8")).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("event-sourced aggregate rejects empty successes and wrong event carriers", async () => {
  const compiler = await Compiler.create();
  try {
    for (const fixture of [
      "src/node/fixtures/event_sourced_aggregate_empty_success.blot",
      "src/node/fixtures/event_sourced_aggregate_event_mismatch.blot",
    ]) {
      await assert.rejects(() => compiler.check(fixture), /BLOT_TYPE_ERROR/);
    }
  } finally {
    compiler.destroy();
  }
});