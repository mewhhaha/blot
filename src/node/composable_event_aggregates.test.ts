import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/composable_event_aggregates.blot";
const expectedType =
  "{ .default = { .deposit = #Ok { .state = Int; .events = [#Deposited 1..100 | #Withdrawn 1..100] } | #Error #Insufficient 1..100; .withdraw = #Ok { .state = Int; .events = [#Deposited 1..100 | #Withdrawn 1..100] } | #Error #Insufficient 1..100; .insufficient = #Ok { .state = Int; .events = [#Deposited 1..100 | #Withdrawn 1..100] } | #Error #Insufficient 1..100; .opened = #Ok { .state = #Closed | #Open; .events = [#Opened | #ClosedEvent] } | #Error (#AlreadyOpen | #AlreadyClosed); .duplicate_open = #Ok { .state = #Open | #Closed; .events = [#Opened | #ClosedEvent] } | #Error (#AlreadyOpen | #AlreadyClosed); .system_left = #Ok { .state = { .0 = Int; .1 = #Closed | #Open }; .events = [#Left (#Deposited 1..100 | #Withdrawn 1..100) | #Right (#Opened | #ClosedEvent)] } | #Error (#Left #Insufficient 1..100 | #Right (#AlreadyOpen | #AlreadyClosed)); .system_right = #Ok { .state = { .0 = Int; .1 = #Closed | #Open }; .events = [#Left (#Deposited 1..100 | #Withdrawn 1..100) | #Right (#Opened | #ClosedEvent)] } | #Error (#Left #Insufficient 1..100 | #Right (#AlreadyOpen | #AlreadyClosed)); .system_left_error = #Ok { .state = { .0 = Int; .1 = #Closed | #Open }; .events = [#Left (#Deposited 1..100 | #Withdrawn 1..100) | #Right (#Opened | #ClosedEvent)] } | #Error (#Left #Insufficient 1..100 | #Right (#AlreadyOpen | #AlreadyClosed)); .system_right_error = #Ok { .state = { .0 = Int; .1 = #Closed | #Open }; .events = [#Left (#Deposited 1..100 | #Withdrawn 1..100) | #Right (#Opened | #ClosedEvent)] } | #Error (#Left #Insufficient 1..100 | #Right (#AlreadyOpen | #AlreadyClosed)); .replayed = { .0 = Int; .1 = #Closed | #Open }; .empty = { .0 = Int; .1 = #Closed | #Open } } }";

const blotSources = [
  "examples/lib/event_aggregate.blot",
  path,
  "src/node/fixtures/event_aggregate_wrong_event.blot",
  "src/node/fixtures/event_aggregate_wrong_command_side.blot",
  "src/node/fixtures/event_aggregate_unannotated_right.blot",
] as const;

test("composable event aggregates preserve state, command, event, and error carriers", async () => {
  const compiler = await Compiler.create();
  try {
    for (const sourcePath of blotSources) {
      const source = await readFile(sourcePath, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error("Blot source failed to format");
      assert.equal(formatted.source, source);
    }

    const checked = await compiler.check(path);
    assert.deepEqual(
      { type: checked.type, effects: checked.effects },
      { type: expectedType, effects: "" },
    );

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/composable_event_aggregates.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile(
        "examples/expected/composable_event_aggregates.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("event aggregate boundaries reject foreign events and wrong product command sides", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () =>
        compiler.check("src/node/fixtures/event_aggregate_wrong_event.blot"),
      /BLOT_TYPE_ERROR/,
    );
    await assert.rejects(
      () =>
        compiler.check(
          "src/node/fixtures/event_aggregate_wrong_command_side.blot",
        ),
      /BLOT_ARGUMENT_MISMATCH/,
    );
  } finally {
    compiler.destroy();
  }
});
