import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { BlotError } from "../diagnostic.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/shared_service_contracts.blot";
const portPath = "examples/lib/shared_service_port.blot";
const consumerPath = "examples/lib/shared_service_consumer.blot";
const providerPath = "examples/lib/shared_service_provider.blot";
const contractDriftPath =
  "src/node/fixtures/shared_service_contract_drift.blot";
const keyDriftPath = "src/node/fixtures/shared_service_key_drift.blot";
const inputMismatchPath =
  "src/node/fixtures/shared_service_input_mismatch.blot";

const blotPaths = [
  portPath,
  consumerPath,
  providerPath,
  examplePath,
  contractDriftPath,
  keyDriftPath,
  inputMismatchPath,
] as const;

async function expectCode(
  compiler: Compiler,
  path: string,
  expectedCode: string,
): Promise<void> {
  await assert.rejects(
    () => compiler.check(path),
    (error: unknown) => {
      assert(error instanceof BlotError);
      assert.equal(error.diagnostic.code, expectedCode);
      return true;
    },
  );
}

test("shared service ports compose across independent imports", async () => {
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
    assert.equal(checked.effects, "");
    assert.equal(checked.interfaceKey, JSON.stringify([checked.type, ""]));
    assert.match(checked.type, /\.ada =/);
    assert.match(checked.type, /\.missing =/);

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/shared_service_contracts.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/shared_service_contracts.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("shared service identity includes both key and operation contract", async () => {
  const compiler = await Compiler.create();
  try {
    await expectCode(compiler, contractDriftPath, "BLOT_UNHANDLED_EFFECT");
    await expectCode(compiler, keyDriftPath, "BLOT_UNHANDLED_EFFECT");
    await expectCode(compiler, inputMismatchPath, "BLOT_TYPE_ERROR");
  } finally {
    compiler.destroy();
  }
});
