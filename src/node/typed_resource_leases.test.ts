import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/typed_resource_leases.blot";
const libraryPath = "examples/lib/resource_lease.blot";
const leakPath = "src/node/fixtures/resource_lease_leak.blot";
const doubleClosePath = "src/node/fixtures/resource_lease_double_close.blot";
const wrongDomainPath = "src/node/fixtures/resource_lease_wrong_domain.blot";
const sameCarrierPath = "src/node/fixtures/resource_lease_same_carrier.blot";

const principalType =
  "{ .default = { .single = #FileClosed { .path = Text; .generation = Int }; .nested = { .file = #FileClosed { .path = Text; .generation = Int }; .lock = #Unlocked Text }; .two_files = { .0 = #FileClosed { .path = Text; .generation = Int }; .1 = #FileClosed { .path = Text; .generation = Int } } } }";

const blotPaths = [
  libraryPath,
  examplePath,
  leakPath,
  doubleClosePath,
  wrongDomainPath,
  sameCarrierPath,
] as const;

test("typed resource leases preserve ownership and receipts in both executions", async () => {
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
      interfaceKey: JSON.stringify([principalType, ""]),
    });

    const evaluated = await compiler.evaluate(examplePath);
    assert.deepEqual(evaluated.writes, []);
    assert.equal(
      evaluated.display,
      (await readFile(
        "examples/expected/typed_resource_leases.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/typed_resource_leases.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("typed resource leases reject ownership mistakes and expose the provenance boundary", async () => {
  const compiler = await Compiler.create();
  try {
    await assert.rejects(
      () => compiler.check(leakPath),
      /BLOT_LINEAR_NOT_CONSUMED: `handle` is linear and is never consumed/,
    );
    await assert.rejects(
      () => compiler.check(doubleClosePath),
      /BLOT_LINEAR_CONSUMED_TWICE: `handle` was already consumed/,
    );
    await assert.rejects(
      () => compiler.check(wrongDomainPath),
      /BLOT_TYPE_ERROR: #FileHandle Int does not flow into #LockToken Int/,
    );

    const sameCarrierType = "{ .default = #RightClosed }";
    assert.deepEqual(await compiler.check(sameCarrierPath), {
      type: sameCarrierType,
      effects: "",
      interfaceKey: JSON.stringify([sameCarrierType, ""]),
    });
    assert.equal(
      (await compiler.evaluate(sameCarrierPath)).display,
      "{ .default = #RightClosed; }",
    );
    assert.equal(
      await runArtifact(await compiler.compile(sameCarrierPath)),
      "#RightClosed",
    );
  } finally {
    compiler.destroy();
  }
});
