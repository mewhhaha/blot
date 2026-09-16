import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { BlotError } from "../diagnostic.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/packed_keys.blot";
const libraryPath = "examples/lib/packed_key.blot";
const wrongDomainPath = "src/node/fixtures/packed_key_wrong_domain.blot";
const outOfRangePath = "src/node/fixtures/packed_key_out_of_range.blot";
const signedFieldPath = "src/node/fixtures/packed_key_signed_field.blot";
const computedWordPath = "examples/pending/packed_key_computed_word_range.blot";

const principalType =
  '{ .default = { .layout = { .bits = 16; .bytes = 2; .first_field = { .name = "version"; .bit_offset = 0; .bit_width = 3; .mask = 7 } | { .name = "kind"; .bit_offset = 3; .bit_width = 5; .mask = 31 } | { .name = "encrypted"; .bit_offset = 8; .bit_width = 1; .mask = 1 } | { .name = "priority"; .bit_offset = 9; .bit_width = 3; .mask = 7 } | { .name = "retries"; .bit_offset = 12; .bit_width = 4; .mask = 15 }; .last_field = { .name = "version"; .bit_offset = 0; .bit_width = 3; .mask = 7 } | { .name = "kind"; .bit_offset = 3; .bit_width = 5; .mask = 31 } | { .name = "encrypted"; .bit_offset = 8; .bit_width = 1; .mask = 1 } | { .name = "priority"; .bit_offset = 9; .bit_width = 3; .mask = 7 } | { .name = "retries"; .bit_offset = 12; .bit_width = 4; .mask = 15 } }; .header = Int; .header_collision = Int; .maximum = Int; .empty = Int; .window = Int } }';

const interfaceType =
  '{ .default = { .layout = { .bits = 16; .bytes = 2; .first_field = { .name = "encrypted"; .bit_offset = 8; .bit_width = 1; .mask = 1 } | { .name = "kind"; .bit_offset = 3; .bit_width = 5; .mask = 31 } | { .name = "priority"; .bit_offset = 9; .bit_width = 3; .mask = 7 } | { .name = "retries"; .bit_offset = 12; .bit_width = 4; .mask = 15 } | { .name = "version"; .bit_offset = 0; .bit_width = 3; .mask = 7 }; .last_field = { .name = "encrypted"; .bit_offset = 8; .bit_width = 1; .mask = 1 } | { .name = "kind"; .bit_offset = 3; .bit_width = 5; .mask = 31 } | { .name = "priority"; .bit_offset = 9; .bit_width = 3; .mask = 7 } | { .name = "retries"; .bit_offset = 12; .bit_width = 4; .mask = 15 } | { .name = "version"; .bit_offset = 0; .bit_width = 3; .mask = 7 } }; .header = Int; .header_collision = Int; .maximum = Int; .empty = Int; .window = Int } }';

const blotPaths = [
  libraryPath,
  examplePath,
  wrongDomainPath,
  outOfRangePath,
  signedFieldPath,
  computedWordPath,
] as const;

test("schema-derived packed keys agree in evaluator and emitted Wasm", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of blotPaths) {
      const source = await readFile(path, "utf8");
      const formatted = await formatSource(source);
      assert.equal(formatted.ok, true);
      if (!formatted.ok) throw new Error(`${path} failed to format`);
      assert.equal(formatted.source, source);
    }

    assert.deepEqual(await compiler.check(examplePath), {
      type: principalType,
      effects: "",
      interfaceKey: JSON.stringify([interfaceType, ""]),
    });

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile("examples/expected/packed_keys.txt", "utf8")).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile("examples/expected/packed_keys.wasm.txt", "utf8")).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("packed keys reject schema, value, and domain mismatches", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(outOfRangePath),
      /BLOT_TYPE_ERROR: 32 does not flow into 0\.\.31/,
    );
    await assert.rejects(
      () => compiler.check(wrongDomainPath),
      /BLOT_TYPE_ERROR: "example\.window\.v1" does not flow into "example\.header\.v1"/,
    );
    await assert.rejects(
      () => compiler.check(signedFieldPath),
      (error: unknown) => {
        assert(error instanceof BlotError);
        assert.equal(error.diagnostic.code, "BLOT_REFUSED");
        assert.match(
          error.diagnostic.message,
          /packed key fields require unsigned U width types/,
        );
        return true;
      },
    );
  } finally {
    compiler.destroy();
  }
});

test("computed packed word range remains a pending inference pressure test", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(computedWordPath),
      /BLOT_TYPE_ERROR: 0\.\.9223372036854775807 does not flow into 0\.\.65535/,
    );
  } finally {
    compiler.destroy();
  }
});
