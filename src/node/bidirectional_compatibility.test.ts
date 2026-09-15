import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { BlotError } from "../diagnostic.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/bidirectional_compatibility.blot";
const libraryPath = "examples/lib/bidirectional_bridge.blot";
const compositionMismatchPath =
  "src/node/fixtures/bidirectional_bridge_composition_mismatch.blot";
const wrongDirectionPath =
  "src/node/fixtures/bidirectional_bridge_wrong_direction.blot";
const resultMismatchPath =
  "src/node/fixtures/bidirectional_bridge_result_mismatch.blot";

const principalType =
  "{ .default = { .admin = #Ok (#Owner Text | #User Text | #Blocked Text | #Unknown Text) | #Error (#First #UnsupportedGuest Text | #Second #PartnerRejectsService Text); .guest_rejected_first = #Ok (#Owner Text | #User Text | #Blocked Text | #Unknown Text) | #Error (#First #UnsupportedGuest Text | #Second #PartnerRejectsService Text); .bot_rejected_second = #Ok (#Owner Text | #User Text | #Blocked Text | #Unknown Text) | #Error (#First #UnsupportedGuest Text | #Second #PartnerRejectsService Text); .blocked_rejected_first = #Ok (#Admin Text | #Member Text | #Bot Text | #Guest Text) | #Error (#First #NotLegacyRole Text | #Second #UnknownPartnerRole Text); .unknown_rejected_second = #Ok (#Admin Text | #Member Text | #Bot Text | #Guest Text) | #Error (#First #NotLegacyRole Text | #Second #UnknownPartnerRole Text); .reverse_owner = #Ok (#Admin Text | #Member Text | #Bot Text | #Guest Text) | #Error (#First #NotLegacyRole Text | #Second #UnknownPartnerRole Text); .identity = #Ok (#Admin Text | #Member Text | #Bot Text | #Guest Text) | #Error #UnsupportedGuest Text } }";

const blotPaths = [
  libraryPath,
  examplePath,
  compositionMismatchPath,
  wrongDirectionPath,
  resultMismatchPath,
] as const;

test("bidirectional compatibility bridges compose directional failures", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of blotPaths) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }

    const checked = await compiler.check(examplePath);
    assert.equal(checked.type, principalType);
    assert.equal(checked.effects, "");

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/bidirectional_compatibility.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/bidirectional_compatibility.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("bidirectional bridges reject incompatible carriers and directions", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of [
      compositionMismatchPath,
      wrongDirectionPath,
      resultMismatchPath,
    ]) {
      await assert.rejects(
        () => compiler.check(path),
        (error: unknown) => {
          assert(error instanceof BlotError);
          assert.equal(error.diagnostic.code, "BLOT_TYPE_ERROR");
          return true;
        },
      );
    }
  } finally {
    compiler.destroy();
  }
});
