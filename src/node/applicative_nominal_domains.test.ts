import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Compiler } from "../compiler.ts";
import { BlotError } from "../diagnostic.ts";
import { formatSource } from "../tooling/formatter.ts";
import { runArtifact } from "./run.ts";

const examplePath = "examples/applicative_nominal_domains.blot";
const domainPath = "examples/lib/nominal_domain.blot";
const customerPath = "examples/lib/customer_identity.blot";
const billingPath = "examples/lib/billing_identity.blot";
const wrongIdPath = "src/node/fixtures/nominal_domain_wrong_id.blot";
const rawEscapePath = "src/node/fixtures/nominal_domain_raw_escape.blot";
const carrierDriftPath = "src/node/fixtures/nominal_domain_carrier_drift.blot";
const collisionPath = "src/node/fixtures/nominal_domain_name_collision.blot";

const principalType =
  '{ .default = { .first = Int; .next = Int; .invoice = Int; .reconstructed = Int; .alias = Text } }';

const blotPaths = [
  domainPath,
  customerPath,
  billingPath,
  examplePath,
  wrongIdPath,
  rawEscapePath,
  carrierDriftPath,
  collisionPath,
] as const;

test("applicative nominal domains agree across independent modules", async () => {
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
        "examples/expected/applicative_nominal_domains.txt",
        "utf8",
      )).trim(),
    );
    assert.equal(
      await runArtifact(await compiler.compile(examplePath)),
      (await readFile(
        "examples/expected/applicative_nominal_domains.wasm.txt",
        "utf8",
      )).trim(),
    );
  } finally {
    compiler.destroy();
  }
});

test("applicative nominal domains reject raw, foreign, and drifted carriers", async () => {
  const compiler = await Compiler.create();
  try {
    for (const path of [wrongIdPath, rawEscapePath, carrierDriftPath]) {
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

test("identical public seal identity intentionally reconstructs one domain", async () => {
  const compiler = await Compiler.create();
  try {
    assert.deepEqual(await compiler.check(collisionPath), {
      type: "{ .default = Int }",
      effects: "",
      interfaceKey: JSON.stringify(["{ .default = Int }", ""]),
    });
    const evaluated = await compiler.evaluate(collisionPath);
    assert.equal(evaluated.display, "{ .default = 9; }");
    assert.equal(
      await runArtifact(await compiler.compile(collisionPath)),
      "{ .default = 9; }",
    );
  } finally {
    compiler.destroy();
  }
});
