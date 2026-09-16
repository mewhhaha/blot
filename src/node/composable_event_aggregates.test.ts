import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { BlotError } from "../diagnostic.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/composable_event_aggregates.blot";
const expectedType =
  "{ .default = { .deposit = #Ok { .state = Int; .events = [#Deposited 1..100 | #Withdrawn 1..100] } | #Error #Insufficient 1..100; .withdraw = #Ok { .state = Int; .events = [#Deposited 1..100 | #Withdrawn 1..100] } | #Error #Insufficient 1..100; .insufficient = #Ok { .state = Int; .events = [#Deposited 1..100 | #Withdrawn 1..100] } | #Error #Insufficient 1..100; .opened = #Ok { .state = #Closed | #Open; .events = [#Opened | #ClosedEvent] } | #Error (#AlreadyOpen | #AlreadyClosed); .duplicate_open = #Ok { .state = #Open | #Closed; .events = [#Opened | #ClosedEvent] } | #Error (#AlreadyOpen | #AlreadyClosed); .system_left = #Ok { .state = { .0 = 8; .1 = #Closed }; .events = [#Left #Deposited 8] }; .system_right = #Ok { .state = { .0 = 8; .1 = #Open }; .events = [#Right #Opened] }; .system_left_error = #Error #Left #Insufficient 5; .system_right_error = #Error #Right #AlreadyOpen; .replayed = { .0 = Int; .1 = #Closed | #Open }; .empty = { .0 = Int; .1 = #Closed | #Open } } }";

const blotSources = [
  "examples/lib/event_aggregate.blot",
  path,
  "src/node/fixtures/event_aggregate_wrong_event.blot",
  "src/node/fixtures/event_aggregate_wrong_command_side.blot",
  "src/node/fixtures/event_aggregate_unannotated_right.blot",
  "src/node/fixtures/higher_order_numeric_context.blot",
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
      (error: unknown) => {
        assert(error instanceof BlotError);
        assert.equal(error.diagnostic.code, "BLOT_ARGUMENT_MISMATCH");
        assert(error.origin !== null);
        assert.match(
          error.origin.path,
          /event_aggregate_wrong_command_side\.blot$/,
        );
        const { start, end } = error.diagnostic.span;
        const callerArgument = error.origin.source.slice(start, end);
        assert.equal(callerArgument, "(system, (0, #False), #Right (#Add 1))");
        assert.match(
          error.diagnostic.message,
          /Required by .*event_aggregate\.blot/,
        );
        return true;
      },
    );
  } finally {
    compiler.destroy();
  }
});

test("unannotated aggregate execution retains its inferred result and runtime values", async () => {
  const fixture = "src/node/fixtures/event_aggregate_unannotated_right.blot";
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check(fixture);
    assert.deepEqual(
      { type: checked.type, effects: checked.effects },
      {
        type:
          "{ .value = #Ok { .state = { .0 = 0; .1 = #False } | { .0 = Int; .1 = #True | #False }; .events = [#Left #Added Int | #Right #Enabled] } | #Error (#Left #LeftRejected | #Right #RightRejected) }",
        effects: "",
      },
    );
    const evaluated = await compiler.evaluate(fixture);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      "{ .value = #Ok { .state = (0, #True); .events = [#Right #Enabled]; }; }",
    );
    assert.equal(
      await runArtifact(await compiler.compile(fixture)),
      "#Ok { .events = [#Right #Enabled]; .state = { .0 = 0; .1 = true } }",
    );
  } finally {
    compiler.destroy();
  }
});

test("higher-order literal resolution preserves an enclosing floating-point requirement", async () => {
  const fixture = "src/node/fixtures/higher_order_numeric_context.blot";
  const compiler = await Compiler.create();
  try {
    const checked = await compiler.check(fixture);
    assert.deepEqual(
      { type: checked.type, effects: checked.effects },
      { type: "F64", effects: "" },
    );
    const evaluated = await compiler.evaluate(fixture);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(evaluated.display, "1");
    assert.deepEqual(evaluated.value, {
      tag: "float",
      value: 1,
      bits: "3ff0000000000000",
    });
    assert.equal(await runArtifact(await compiler.compile(fixture)), "1");
  } finally {
    compiler.destroy();
  }
});
