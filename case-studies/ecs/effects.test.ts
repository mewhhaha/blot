import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../../src/compiler.ts";
import { instantiateArtifact } from "../../src/host.ts";
import { observeArtifact } from "../../src/node/run.ts";
import { evaluationObservation } from "../../src/runtime_observation.ts";

function row(Position: bigint, Velocity: bigint) {
  return {
    kind: "record" as const,
    fields: new Map([["Position", Position], ["Velocity", Velocity]]),
  };
}

test("merged stateful computations keep their effects and execute on every row", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "case-studies/ecs/stateful.blot";
    const source = await readFile(path, "utf8");
    const prefix = source.slice(0, source.indexOf("let apply ::"));
    const observation = "case-studies/ecs/state-effect.test.blot";
    const computation = await compiler.checkSource(
      observation,
      `${prefix}\nreturn movement\n`,
    );
    assert.match(computation.type, /Unit -> Unit ~ \{ .*State \}/);
    await assert.rejects(
      compiler.checkSource(
        observation,
        `${prefix}\nuse movement ()\nreturn ()\n`,
      ),
      /BLOT_UNHANDLED_EFFECT/,
    );
    const observationPath = "case-studies/ecs/state-observation.test.blot";
    await compiler.checkSource(
      observationPath,
      'const S = import "./stateful.blot"\nreturn S.default\n',
    );
    const evaluated = await compiler.evaluate(observationPath);
    const emitted = await observeArtifact(
      await compiler.compile(observationPath),
    );
    assert.deepEqual(
      evaluationObservation(evaluated.value, emitted.type),
      emitted.value,
    );
    assert.deepEqual(emitted.value, [row(8n, 3n), row(44n, 2n)]);
    const artifact = await compiler.compile(path);
    const guest = await instantiateArtifact(artifact);
    try {
      assert.deepEqual(guest.call("default"), [row(8n, 3n), row(44n, 2n)]);
      for (const position of [-100n, 0n, 1n, 12n, 12n]) {
        assert.deepEqual(guest.call("apply", [position]), [
          row((position + 3n) * 2n, 3n),
          row(44n, 2n),
        ]);
      }
    } finally {
      guest.destroy();
    }
  } finally {
    compiler.destroy();
  }
});

test("constructed handlers capture runtime values and retain continuation checks", async () => {
  const compiler = await Compiler.create();
  try {
    const path = "case-studies/ecs/constructed-handler.blot";
    assert.deepEqual(await compiler.check(path), {
      type: "Int -> Int",
      effects: "",
    });
    const guest = await instantiateArtifact(await compiler.compile(path));
    try {
      for (const value of [-12n, 0n, 42n, 42n]) {
        assert.equal(guest.call("default", [value]), value);
      }
    } finally {
      guest.destroy();
    }
    const source = await readFile(path, "utf8");
    await assert.rejects(
      compiler.checkSource(
        "case-studies/ecs/handler-dynamic.test.blot",
        source.replace(
          "const supply = fn value => { .get = fn ((), ?resume) => resume value; }",
          `const supply = fn value => case value > 0 of
  #True => { .get = fn ((), ?resume) => resume value; }
  #False => { .get = fn ((), ?resume) => resume 0; }
`,
        ),
      ),
      /Handler clauses must be selected statically/,
    );
    await assert.rejects(
      compiler.checkSource(
        "case-studies/ecs/handler-affinity.test.blot",
        source.replace("?resume", "resume"),
      ),
      /BLOT_HANDLER_RESUME_NOT_AFFINE/,
    );
    await assert.rejects(
      compiler.checkSource(
        "case-studies/ecs/handler-type.test.blot",
        source.replace("supply value)", 'supply "wrong")'),
      ),
      /BLOT_TYPE_ERROR/,
    );
    await assert.rejects(
      compiler.checkSource(
        "case-studies/ecs/handler-unbound.test.blot",
        source.replace("supply value)", "supply missing)"),
      ),
      /BLOT_UNBOUND/,
    );
  } finally {
    compiler.destroy();
  }
});
