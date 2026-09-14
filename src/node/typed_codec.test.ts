import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const path = "examples/typed_codec.blot";
const expectedType =
  "{ .default = { .encoded = { .guests = Int; .nights = Int }; .valid = #Ok { .guests = 1..8; .nights = 1..30 } | #Error (#InvalidGuests Int | #InvalidNights Int); .invalid_guests = #Ok { .guests = 1..8; .nights = 1..30 } | #Error (#InvalidGuests Int | #InvalidNights Int); .invalid_nights = #Ok { .guests = 1..8; .nights = 1..30 } | #Error (#InvalidGuests Int | #InvalidNights Int); .both_invalid = #Ok { .guests = 1..8; .nights = 1..30 } | #Error (#InvalidGuests Int | #InvalidNights Int); .boundary = #Ok { .guests = 1..8; .nights = 1..30 } | #Error (#InvalidGuests Int | #InvalidNights Int); .round_trip = #Ok { .guests = 1..8; .nights = 1..30 } | #Error (#InvalidGuests Int | #InvalidNights Int) } }";

test("typed codec preserves carrier relationships in both executions", async () => {
  const compiler = await Compiler.create();
  try {
    const source = await readFile(path, "utf8");
    const formatted = await formatSource(source);
    assert.equal(formatted.ok, true);
    if (!formatted.ok) throw new Error("accepted example failed to format");
    assert.equal(formatted.source, source);

    const checkedInterface1 = await compiler.check(path);
    assert.deepEqual({
      type: checkedInterface1.type,
      effects: checkedInterface1.effects,
    }, {
      type: expectedType,
      effects: "",
    });

    const evaluated = await compiler.evaluate(path);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/typed_codec.txt", "utf8")).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(path)),
      (await readFile("examples/expected/typed_codec.wasm.txt", "utf8")).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test(
  "typed codec rejects invalid models, one-way remaps, and dropped product errors",
  async () => {
    const compiler = await Compiler.create();
    try {
      for (
        const fixture of [
          "src/node/fixtures/codec_invalid_reservation.blot",
          "src/node/fixtures/codec_backward_mismatch.blot",
          "src/node/fixtures/codec_error_union_mismatch.blot",
        ]
      ) {
        await assert.rejects(() => compiler.check(fixture), /BLOT_TYPE_ERROR/);
      }
    } finally {
      compiler.destroy();
    }
  },
);
